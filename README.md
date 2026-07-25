# Calendario de Contenido

Una aplicación web para gestionar un calendario editorial de Instagram con soporte para reels, carruseles y stories.

## Características

- 📅 Calendario mensual interactivo
- 🎬 Gestión de reels, carruseles y stories
- 🏷️ Sistema de ángulos de contenido personalizables
- 💬 Generador de copy impulsado por IA (Gemini)
- 📊 Estadísticas de contenido
- 🔍 Búsqueda cross-mes de posts
- 💡 Panel de ideas para contenido futuro
- 🔄 Reglas de contenido recurrentes
- 📝 Notas del cliente por post
- 👥 Soporte multi-cliente
- 🔒 Modo lectura protegido

## Instalación

1. Abre `calendario-contenido.html` en tu navegador
2. Configura la URL del backend (Google Apps Script) en ⚙️ Configuración
3. Comienza a gestionar tu contenido

## Backend (Google Apps Script)

El archivo `backend-apps-script.gs` contiene la lógica del servidor que:
- Persiste datos en Google Sheets
- Genera copy automáticamente con Gemini API
- Genera reglas de contenido recurrentes

### Setup del backend:
1. Crea una Google Sheet nueva
2. Extensiones > Apps Script
3. Pega el contenido de `backend-apps-script.gs`
4. Implementa como "Aplicación web"
5. Copia la URL de implementación en Configuración del calendario

## Estructura de archivos

```
.
├── calendario-contenido.html      # Aplicación principal (single-file)
├── backend-apps-script.gs         # Backend (Google Apps Script)
├── README.md                       # Este archivo
└── .gitignore
```

## Licencia

Privado - Uso interno únicamente
