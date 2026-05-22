# InclúyeTE+ · Plataforma de envío WhatsApp

## Despliegue en Railway (una sola vez)

### 1. Sube el código a GitHub
1. Ve a https://github.com/new y crea un repositorio nuevo (ej. `llegate-whatsapp`)
2. En tu computador, abre una terminal en esta carpeta y ejecuta:
```
git init
git add .
git commit -m "primera versión"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/llegate-whatsapp.git
git push -u origin main
```

### 2. Despliega en Railway
1. Ve a https://railway.app e inicia sesión con tu cuenta de GitHub
2. Clic en **New Project → Deploy from GitHub repo**
3. Selecciona el repositorio `llegate-whatsapp`
4. Railway lo detecta y despliega automáticamente
5. Una vez desplegado, ve a **Settings → Networking → Generate Domain**
6. Copia la URL que te genera (ej. `llegate-whatsapp.up.railway.app`)

¡Listo! Comparte esa URL con tu equipo.

---

## Uso diario

1. Cada persona del equipo abre la URL en su navegador
2. Sube el Excel con los números (columna A = teléfono 1, columna B = teléfono 2 opcional)
3. Sube la imagen (opcional)
4. Escribe el mensaje
5. Escanea el QR con su WhatsApp Business personal
6. El envío arranca automáticamente — máximo 50 mensajes, 60 segundos de intervalo

---

## Notas importantes

- Cada persona usa **su propio número** de WhatsApp Business
- La sesión de WhatsApp se guarda en el servidor — si Railway reinicia el servidor hay que escanear el QR de nuevo
- No bajar de 60 segundos de intervalo para evitar bloqueos
- Máximo recomendado: 50 mensajes por sesión por número
