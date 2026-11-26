# Finanzas FVR

Aplicación web para llevar el presupuesto de un hogar entre dos personas, con cuenta compartida y datos en la nube.

## Qué hace

- **Registro rápido** de gastos e ingresos. El monto va primero y hay atajos con las subcategorías más usadas.
- **Presupuesto por subcategoría.** La categoría padre suma automáticamente el de sus subcategorías, y cada movimiento se cruza contra el presupuesto de la suya.
- **Maestros configurables:** crear, renombrar y eliminar categorías y subcategorías. Al renombrar, los movimientos ya registrados se actualizan solos.
- **Dashboard mensual** con treemap de gasto por categoría, ejecutado vs. presupuesto por subcategoría y curva de gasto acumulado.
- **Cierre de mes** en cinco pasos: constancia del registro, conciliación contra el banco, foto del patrimonio, evaluación de 0 a 100 y presupuesto del mes siguiente.
- **Patrimonio y plan de deuda** con estrategias de avalancha y bola de nieve.
- **Comportamiento en el tiempo:** evolución de cualquier categoría o subcategoría mes a mes contra su presupuesto, con tendencia.
- **Guía hablada** que lee el instructivo resaltando cada sección y mantiene la pantalla encendida.
- **Modo claro y oscuro**, y funcionamiento sin conexión con la copia local.

Todas las cifras en pesos, con separador de miles y sin decimales.

## Cómo se usa entre dos personas

Ambos entran con **el mismo correo y la misma contraseña**: es una sola cuenta del hogar. Lo que registra uno le aparece al otro, en cualquier dispositivo, dentro de unos veinte segundos o al instante si vuelve a abrir la app.

Quien solo quiera probarla puede entrar con **Ver demostración** (datos de ejemplo, nada se guarda) o con **Trabajar sin cuenta** (datos solo en ese navegador).

## Arquitectura

```
index.html    La aplicación completa (HTML, CSS y JS en un solo archivo)
server.js     Servidor Node: sirve la app y expone la API sobre Postgres
Dockerfile    Imagen de despliegue
railway.json  Indica a Railway que construya con el Dockerfile
```

Un solo servicio sirve la página y la API, así que todo vive en el mismo origen: no hay CORS y la cookie de sesión puede ser `httpOnly`.

### Variables de entorno

| Variable | Para qué |
|---|---|
| `DATABASE_URL` | Conexión a Postgres. En Railway se referencia como `${{Postgres.DATABASE_URL}}`. |
| `JWT_SECRET` | Firma las sesiones. Mínimo 32 caracteres; **sin ella el servidor no arranca**. |
| `NODE_ENV` | `production` en Railway. |

Las tablas se crean solas al arrancar; no hay que correr migraciones a mano.

### Seguridad

- Contraseñas con **bcrypt** (coste 12). Nunca se guardan ni se registran en claro.
- Sesión en cookie **httpOnly + Secure + SameSite=Lax**: el JavaScript de la página no puede leerla, así que un script inyectado no se la puede robar.
- Todas las consultas **parametrizadas**; no se concatena SQL.
- Cada fila lleva `user_id` y **toda** consulta filtra por el usuario de la sesión. Verificado: una cuenta no ve ni puede borrar datos de otra.
- **Ocho intentos** de ingreso por correo e IP cada quince minutos.
- El mismo mensaje de error exista o no el correo, para que no se pueda averiguar qué correos tienen cuenta.

El punto débil real no es el código sino la contraseña: úsala larga y no la repitas en otro servicio.

## Desplegar

Railway construye y publica con cada `push` a `main`. Para otro entorno:

```bash
npm install
DATABASE_URL=postgres://... JWT_SECRET=<48+ caracteres aleatorios> npm start
```

## Respaldos

En **Historial** hay exportación a CSV y a JSON, y restauración desde JSON. Conviene bajar un respaldo antes de cualquier cambio grande.
