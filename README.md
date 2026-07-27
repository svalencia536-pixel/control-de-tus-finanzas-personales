# 💰 Finanzas Hogar

Aplicación web para llevar el presupuesto de un hogar entre dos personas, con datos compartidos en tiempo real.

## Qué hace

- **Registro rápido** de gastos e ingresos, con categoría, subcategoría, cuenta y detalle.
- **Presupuesto por subcategoría.** La categoría padre suma automáticamente el de sus subcategorías, y cada movimiento se cruza contra el presupuesto de la subcategoría que elijas.
- **Maestros configurables:** crear, renombrar y eliminar categorías y subcategorías, y asignarles presupuesto. Al renombrar, los movimientos ya registrados se actualizan solos.
- **Dashboard mensual** con distribución por categoría, ejecutado vs. presupuesto por subcategoría y curva de gasto acumulado.
- **Análisis automático:** tasa de ahorro, subcategorías excedidas, subcategorías sin presupuesto y proyección del fondo de emergencia.
- **Tiempo real:** lo que registra una persona le aparece a la otra sin refrescar.
- **Funciona sin internet** con una copia local, y sincroniza al reconectar.
- **Respaldo** exportable a CSV y a JSON.

Todas las cifras se muestran en pesos con separador de miles y sin decimales.

## Puesta en marcha

### 1. Crear el proyecto en Supabase

1. Entra a [supabase.com](https://supabase.com) y crea un proyecto (plan gratuito).
2. Abre **SQL Editor → New query**, pega el contenido de [`supabase_setup.sql`](supabase_setup.sql) y pulsa **Run**.
3. Ve a **Project Settings → API** y copia el **Project URL** y la **anon public key**.

> La `anon key` está diseñada para ir en el navegador: es pública y segura de publicar. La seguridad real la da *Row Level Security*, que el script deja configurado para que cada cuenta solo pueda leer y escribir sus propios datos. **Nunca publiques la `service_role key`.**

### 2. Abrir la app

1. Abre `index.html` (o la URL donde esté publicada).
2. Pega el **Project URL** y la **anon key**.
3. Pulsa **Crear la cuenta del hogar** con un correo y contraseña.
4. La otra persona entra con **esas mismas credenciales**: así comparten un solo presupuesto.

> Supabase pide confirmar el correo por defecto. Para saltarte ese paso: **Authentication → Sign In / Providers → Email** y desactiva *Confirm email*.

## Publicar

### Railway (recomendado)

El repositorio trae `Dockerfile` y `Caddyfile`: Railway detecta el Dockerfile y sirve el sitio sin más configuración.

1. En Railway: **New Project → Deploy from GitHub repo** y elige este repositorio.
2. Cuando termine el build, entra al servicio → **Settings → Networking → Generate Domain**.
3. Para dominio propio: **Custom Domain** y apunta el CNAME que Railway te indique.

No hay que definir variables de entorno: Railway inyecta `PORT` y el `Caddyfile` la toma sola.

### GitHub Pages (alternativa gratuita)

**Settings → Pages → Source: Deploy from a branch → Branch: `main` / `root`**. Requiere repositorio público. Queda en `https://<usuario>.github.io/<repositorio>/`.

## Nota sobre el código

Es una aplicación de un solo archivo que corre completa en el navegador; no hay servidor propio. El código fuente es visible para cualquiera que abra la página, así que **el valor está en el servicio** —la base de datos, las cuentas y el soporte—, no en el archivo.

## Estructura

```
index.html            La aplicación completa (HTML, CSS y JS en un solo archivo)
supabase_setup.sql    Esquema de base de datos, seguridad y tiempo real
Dockerfile            Imagen de despliegue (Caddy sirviendo el estático)
Caddyfile             Configuración del servidor web
railway.json          Le indica a Railway que construya con el Dockerfile
```

Sin dependencias que instalar. La única librería externa es el cliente de Supabase, que se carga desde CDN.
