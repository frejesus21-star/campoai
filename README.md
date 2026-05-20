# 🌾 CampoIA

Asistente agronómico IA para pequeños agricultores chilenos vía WhatsApp.

## Deploy en Railway (10 minutos)

### 1. Preparar repositorio
```bash
git init && git add . && git commit -m "init campoai"
gh repo create campoai --public --push
```

### 2. Crear proyecto en Railway
1. railway.app → New Project → Deploy from GitHub
2. Selecciona tu repo campoai
3. Railway detecta automáticamente Node.js

### 3. Agregar PostgreSQL
En Railway: + New → PostgreSQL
Railway configura `DATABASE_URL` automáticamente ✅

### 4. Configurar variables de entorno en Railway
```
WHATSAPP_TOKEN        → desde Meta Developers
WHATSAPP_PHONE_ID     → desde Meta Developers
WEBHOOK_VERIFY_TOKEN  → invéntalo tú (ej: campoai_2024_xyz)
ANTHROPIC_API_KEY     → console.anthropic.com
FIRMS_API_KEY         → firms.modaps.eosdis.nasa.gov
```

### 5. Configurar webhook en Meta
1. Meta Developers → tu app → WhatsApp → Configuración
2. URL del webhook: `https://tu-app.railway.app/webhook`
3. Token de verificación: el mismo WEBHOOK_VERIFY_TOKEN
4. Suscribir a: `messages`

### 6. Probar
Envía "hola" al número de WhatsApp Business 🎉

## Comandos del agricultor
- `/ayuda` — ver comandos disponibles
- `/cultivo papa` — registrar cultivo
- `/nombre Juan` — registrar nombre  
- `/estado` — ver perfil
- Compartir ubicación GPS — activa alertas de clima e incendios
