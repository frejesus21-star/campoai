// ============================================================
//  CampoIA - server.js
//  Asistente agronómico vía WhatsApp para Chile
//  Stack: Node.js + Express | Deploy: Railway
// ============================================================

import express from "express";
import pg from "pg";
import fetch from "node-fetch";
import "dotenv/config";

const app = express();
app.use(express.json());

// ─────────────────────────────────────────────
//  CONFIG — todas las variables van en .env
// ─────────────────────────────────────────────
const {
  WHATSAPP_TOKEN,        // Token de acceso Meta (permanente)
  WHATSAPP_PHONE_ID,     // ID del número de teléfono de WhatsApp Business
  WEBHOOK_VERIFY_TOKEN,  // Token propio para verificar el webhook con Meta
  ANTHROPIC_API_KEY,     // Clave de Claude (console.anthropic.com)
  FIRMS_API_KEY,         // Clave NASA FIRMS (firms.modaps.eosdis.nasa.gov)
  DATABASE_URL,          // URL de PostgreSQL (Railway provee esta automáticamente)
  PORT = 3000,
} = process.env;

// ─────────────────────────────────────────────
//  BASE DE DATOS
// ─────────────────────────────────────────────
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // necesario en Railway
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agricultores (
      phone        TEXT PRIMARY KEY,
      nombre       TEXT,
      cultivo      TEXT,
      lat          NUMERIC,
      lon          NUMERIC,
      creado_en    TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS conversaciones (
      id           SERIAL PRIMARY KEY,
      phone        TEXT NOT NULL,
      rol          TEXT NOT NULL CHECK (rol IN ('user','assistant')),
      contenido    TEXT NOT NULL,
      creado_en    TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_conv_phone
      ON conversaciones(phone, creado_en DESC);
  `);
  console.log("✅ Base de datos lista");
}

async function getAgricultor(phone) {
  const { rows } = await pool.query(
    "SELECT * FROM agricultores WHERE phone = $1",
    [phone]
  );
  return rows[0] || null;
}

async function upsertAgricultor(data) {
  await pool.query(
    `INSERT INTO agricultores (phone, nombre, cultivo, lat, lon)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (phone) DO UPDATE
       SET nombre=$2, cultivo=$3, lat=$4, lon=$5`,
    [data.phone, data.nombre, data.cultivo, data.lat, data.lon]
  );
}

async function getHistorial(phone, limite = 6) {
  const { rows } = await pool.query(
    `SELECT rol, contenido FROM conversaciones
     WHERE phone = $1
     ORDER BY creado_en DESC LIMIT $2`,
    [phone, limite]
  );
  return rows.reverse(); // cronológico para Claude
}

async function guardarMensaje(phone, rol, contenido) {
  await pool.query(
    "INSERT INTO conversaciones (phone, rol, contenido) VALUES ($1,$2,$3)",
    [phone, rol, contenido]
  );
}

// ─────────────────────────────────────────────
//  WHATSAPP — envío de mensajes
// ─────────────────────────────────────────────
async function sendWA(to, text) {
  const url = `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error("❌ Error enviando WhatsApp:", err);
  }
}

// Marca el mensaje como "leyendo..." para mejor UX
async function markRead(messageId) {
  const url = `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_ID}/messages`;
  await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
    }),
  }).catch(() => {}); // no bloquear si falla
}

// ─────────────────────────────────────────────
//  OPEN-METEO — clima gratis, sin API key
// ─────────────────────────────────────────────
async function getWeather(lat, lon) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", lat);
  url.searchParams.set("longitude", lon);
  url.searchParams.set("daily", [
    "temperature_2m_max",
    "temperature_2m_min",
    "precipitation_probability_max",
    "precipitation_sum",
    "frost_risk_index_min",   // índice 0-4, >2 = riesgo helada
    "wind_speed_10m_max",
  ].join(","));
  url.searchParams.set("current", "temperature_2m,relative_humidity_2m");
  url.searchParams.set("timezone", "America/Santiago");
  url.searchParams.set("forecast_days", "3");

  const res = await fetch(url.toString());
  if (!res.ok) return null;
  return res.json();
}

function formatWeather(data) {
  if (!data) return "Clima no disponible";
  const { daily: d, current: c } = data;
  const dias = ["Hoy", "Mañana", "Pasado mañana"];
  const resumen = dias.map((dia, i) => {
    const helada = d.frost_risk_index_min[i] >= 3
      ? " ⚠️ RIESGO HELADA"
      : d.frost_risk_index_min[i] >= 1
        ? " (helada leve posible)"
        : "";
    return `  • ${dia}: ${d.temperature_2m_min[i]}°C – ${d.temperature_2m_max[i]}°C, lluvia ${d.precipitation_probability_max[i]}%${helada}`;
  }).join("\n");

  return `Ahora: ${c.temperature_2m}°C, humedad ${c.relative_humidity_2m}%\n${resumen}`;
}

// ─────────────────────────────────────────────
//  NASA FIRMS — incendios activos, gratis
//  Registra tu key en: firms.modaps.eosdis.nasa.gov
// ─────────────────────────────────────────────
async function checkFires(lat, lon) {
  try {
    const delta = 1.0; // ~111km de radio
    const bbox = [lon - delta, lat - delta, lon + delta, lat + delta].join(",");
    const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${FIRMS_API_KEY}/VIIRS_SNPP_NRT/${bbox}/1`;
    const csv = await fetch(url).then((r) => r.text());
    const rows = csv.trim().split("\n");
    return rows.length > 1; // encabezado + al menos 1 registro = fuego
  } catch {
    return false; // no bloquear si falla
  }
}

// ─────────────────────────────────────────────
//  CLAUDE — razonamiento agronómico
// ─────────────────────────────────────────────
async function askClaude(pregunta, agricultor, climaStr, hayIncendio, historial) {
  const cultivoCtx = agricultor?.cultivo
    ? `El agricultor cultiva principalmente: ${agricultor.cultivo}.`
    : "No se conoce el cultivo del agricultor.";

  const nombreCtx = agricultor?.nombre
    ? `Su nombre es ${agricultor.nombre}.`
    : "";

  const incendioCtx = hayIncendio
    ? "\n⚠️ ALERTA CRÍTICA: Hay incendios forestales activos dentro de 100km del campo. Menciona esto si es relevante y recomienda revisar alertas de CONAF."
    : "";

  const systemPrompt = `Eres CampoIA, un agrónomo virtual experto en agricultura chilena.
Tu misión es ayudar a pequeños agricultores con consejos prácticos en español sencillo.

${cultivoCtx} ${nombreCtx}

CLIMA ACTUAL DEL CAMPO:
${climaStr}
${incendioCtx}

INSTRUCCIONES:
- Responde en español conversacional y simple. Máximo 4 oraciones.
- Prioriza información práctica y accionable para HOY o MAÑANA.
- Si hay riesgo de helada (índice ≥3), adviértelo siempre primero.
- Si preguntan por precios, recomienda revisar odepa.gob.cl para datos actualizados.
- Nunca menciones que eres IA. Eres un asesor agrícola digital.
- Si no sabes algo con certeza, dilo honestamente.`;

  const messages = [
    ...historial.map((h) => ({ role: h.rol, content: h.contenido })),
    { role: "user", content: pregunta },
  ];

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 450,
      system: systemPrompt,
      messages,
    }),
  });

  if (!res.ok) {
    console.error("❌ Error Claude API:", await res.text());
    return "Lo siento, tuve un problema técnico. Intenta de nuevo en unos minutos.";
  }

  const data = await res.json();
  return data.content[0].text;
}

// ─────────────────────────────────────────────
//  COMANDOS ESPECIALES via WhatsApp
//  El agricultor puede configurar su perfil
//  enviando: /cultivo papa   o   /nombre Juan
// ─────────────────────────────────────────────
async function handleComando(phone, texto, agricultor) {
  const cmd = texto.trim().toLowerCase();

  if (cmd === "/ayuda" || cmd === "ayuda") {
    return `*CampoIA — Comandos disponibles:*

📍 */ubicacion* — Envía tu ubicación GPS (comparte ubicación desde WhatsApp)
🌱 */cultivo [nombre]* — Ej: /cultivo papa
👤 */nombre [tu nombre]* — Ej: /nombre Juan
📊 */estado* — Ver tu perfil actual
❓ Cualquier otra pregunta se responde automáticamente.`;
  }

  if (cmd === "/estado") {
    if (!agricultor) return "Aún no tienes perfil. Envía /ayuda para comenzar.";
    return `*Tu perfil CampoIA:*
👤 Nombre: ${agricultor.nombre || "no registrado"}
🌱 Cultivo: ${agricultor.cultivo || "no registrado"}
📍 Ubicación: ${agricultor.lat ? "✅ registrada" : "❌ no registrada"}`;
  }

  if (cmd.startsWith("/cultivo ")) {
    const cultivo = texto.slice(9).trim();
    await upsertAgricultor({
      phone,
      nombre: agricultor?.nombre,
      cultivo,
      lat: agricultor?.lat,
      lon: agricultor?.lon,
    });
    return `✅ Cultivo actualizado: *${cultivo}*\nAhora puedo darte consejos más específicos.`;
  }

  if (cmd.startsWith("/nombre ")) {
    const nombre = texto.slice(8).trim();
    await upsertAgricultor({
      phone,
      nombre,
      cultivo: agricultor?.cultivo,
      lat: agricultor?.lat,
      lon: agricultor?.lon,
    });
    return `✅ Nombre guardado: *${nombre}* 👋`;
  }

  return null; // no es un comando conocido
}

// ─────────────────────────────────────────────
//  PROCESADOR PRINCIPAL DE MENSAJES
// ─────────────────────────────────────────────
async function handleMessage(phone, messageId, message) {
  await markRead(messageId);

  const agricultor = await getAgricultor(phone);
  let replyText;

  // Mensaje de ubicación GPS (el usuario comparte su ubicación en WhatsApp)
  if (message.type === "location") {
    const { latitude: lat, longitude: lon } = message.location;
    await upsertAgricultor({
      phone,
      nombre: agricultor?.nombre,
      cultivo: agricultor?.cultivo,
      lat,
      lon,
    });
    replyText = `✅ Ubicación guardada (${lat.toFixed(4)}, ${lon.toFixed(4)}).\n\nAhora puedo ver el clima y alertas específicos de tu campo. ¿En qué te puedo ayudar hoy?`;
    return sendWA(phone, replyText);
  }

  // Solo procesamos mensajes de texto
  if (message.type !== "text") {
    return sendWA(
      phone,
      "Por ahora solo proceso texto y ubicaciones GPS. Envíame tu pregunta o comparte tu ubicación."
    );
  }

  const texto = message.text.body;

  // Primer contacto: bienvenida
  if (!agricultor) {
    await upsertAgricultor({ phone, nombre: null, cultivo: null, lat: null, lon: null });
    replyText = `👋 Hola, soy *CampoIA*, tu asesor agrícola digital.

Para darte información de clima e incendios de tu zona, comparte tu ubicación GPS (📎 → Ubicación en WhatsApp).

También puedes preguntarme directamente sobre tus cultivos. ¿En qué te ayudo?

Envía */ayuda* para ver todos los comandos.`;
    return sendWA(phone, replyText);
  }

  // Comandos especiales
  const cmdReply = await handleComando(phone, texto, agricultor);
  if (cmdReply) return sendWA(phone, cmdReply);

  // Consulta agronómica normal — enriquecer con datos en paralelo
  const [climaData, hayIncendio, historial] = await Promise.all([
    agricultor.lat ? getWeather(agricultor.lat, agricultor.lon) : null,
    agricultor.lat ? checkFires(agricultor.lat, agricultor.lon) : false,
    getHistorial(phone, 6),
  ]);

  const climaStr = agricultor.lat
    ? formatWeather(climaData)
    : "Ubicación no registrada. Pide al agricultor que comparta su ubicación.";

  replyText = await askClaude(texto, agricultor, climaStr, hayIncendio, historial);

  // Guardar conversación para contexto futuro
  await Promise.all([
    guardarMensaje(phone, "user", texto),
    guardarMensaje(phone, "assistant", replyText),
  ]);

  await sendWA(phone, replyText);
}

// ─────────────────────────────────────────────
//  RUTAS WEBHOOK
// ─────────────────────────────────────────────

// GET — verificación inicial de Meta (solo se hace 1 vez al configurar)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
    console.log("✅ Webhook verificado por Meta");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// POST — mensajes entrantes de WhatsApp
app.post("/webhook", async (req, res) => {
  // Responder 200 inmediatamente (Meta requiere < 5s o reintenta)
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // Solo procesar mensajes (ignorar status updates)
    if (!value?.messages) return;

    const message = value.messages[0];
    const phone = message.from;
    const messageId = message.id;

    await handleMessage(phone, messageId, message);
  } catch (err) {
    console.error("❌ Error procesando mensaje:", err);
  }
});

// Health check para Railway
app.get("/health", (_, res) => res.json({ status: "ok", service: "CampoIA" }));

// ─────────────────────────────────────────────
//  ARRANQUE
// ─────────────────────────────────────────────
async function main() {
  await initDB();
  app.listen(PORT, () => {
    console.log(`🌾 CampoIA corriendo en puerto ${PORT}`);
  });
}

main().catch((err) => {
  console.error("❌ Error fatal:", err);
  process.exit(1);
});
