# Preparar y compilar la APK

## Requisitos

- Node.js y npm.
- Android Studio con Android SDK instalado.
- JDK compatible con la versión de Android Gradle Plugin que instale Capacitor.

## Primera configuración Android

Desde `gilda-app`:

```bash
npx cap add android
npm run cap:sync
npx cap open android
```

En Android Studio, compila con **Build > Build Bundle(s) / APK(s) > Build APK(s)**. También puedes usar:

```bash
cd android && ./gradlew assembleDebug
```

El APK de depuración se genera en `android/app/build/outputs/apk/debug/`.

## Actualizar la app nativa

Después de cambiar la app web:

```bash
npm run cap:sync
```

Después vuelve a compilar desde Android Studio o ejecuta `cd android && ./gradlew assembleDebug`.

## Push

La UI detecta el plugin `@capacitor/push-notifications` en dispositivos nativos. Para recibir mensajes reales hay que configurar Firebase Cloud Messaging, añadir el `google-services.json` de la app Android y desplegar el backend que almacena y envía los tokens recibidos por `registrar_token_push`.

En web, configura `VITE_VAPID_PUBLIC_KEY` antes de compilar y despliega en HTTPS. Apps Script debe almacenar las suscripciones de `registrar_suscripcion_push` y un servidor debe enviar notificaciones Web Push cifradas. El Service Worker muestra la notificación cuando recibe el evento `push`; el permiso, por sí solo, no entrega mensajes.

## Acciones administrativas y otras escrituras

El panel cliente emite acciones administrativas con `email_admin`. El Apps Script debe validar ese correo en servidor antes de ejecutar `gestionar_lectura_club`, `moderar_chat`, `gestionar_propuesta`, `validar_capitulo`, `publicar_cita` o la votación de cafecitos. La comprobación de email en React solo controla la interfaz y no sustituye autorización del backend.
