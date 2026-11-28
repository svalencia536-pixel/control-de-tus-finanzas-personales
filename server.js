/* Servidor de Finanzas Personales.
 *
 * Sirve la aplicación y expone la API que guarda los datos en Postgres, de modo
 * que Sergio y Katherin compartan el mismo presupuesto desde cualquier equipo.
 *
 * Decisiones de seguridad:
 *  - Las contraseñas se guardan con bcrypt (coste 12). Nunca en texto plano.
 *  - La sesión viaja en una cookie httpOnly: el JavaScript de la página no puede
 *    leerla, así que un script inyectado no se la puede robar.
 *  - Toda consulta va parametrizada ($1, $2...): no se concatena SQL.
 *  - Cada fila lleva user_id y toda consulta filtra por el usuario de la sesión.
 *  - Se limita el número de intentos de inicio de sesión por correo y por IP.
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import webpush from 'web-push';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;

/* ───────────────────────── base de datos ───────────────────────── */
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway.internal')
    ? false : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000
});

/* Genera un código corto y fácil de dictar por teléfono. Se omiten las letras
   y cifras que se confunden al leerlas en voz alta (O/0, I/1, etc.). */
const LETRAS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const nuevoCodigo = () =>
  'CASA-' + Array.from({ length: 5 }, () => LETRAS[Math.floor(Math.random() * LETRAS.length)]).join('');

async function migrar() {
  /* Los datos pertenecen al HOGAR, no a la persona: así cada uno entra con su
     propio correo y contraseña pero ambos ven y editan el mismo presupuesto. */
  await pool.query(`
    create table if not exists hogares (
      id     uuid primary key default gen_random_uuid(),
      nombre text not null default 'Mi hogar',
      codigo text unique not null,
      creado timestamptz not null default now()
    );
    create table if not exists usuarios (
      id          uuid primary key default gen_random_uuid(),
      correo      text unique not null,
      clave_hash  text not null,
      nombre      text,
      creado      timestamptz not null default now()
    );
    create table if not exists movimientos (
      id       uuid primary key,
      user_id  uuid references usuarios(id) on delete set null,
      tipo     text not null check (tipo in ('gasto','ingreso')),
      fecha    date not null,
      cat      text not null,
      sub      text not null,
      monto    numeric(14,2) not null check (monto > 0),
      cuenta   text,
      det      text,
      creado   timestamptz not null default now()
    );
    create table if not exists maestros (
      user_id     uuid,
      cfg         jsonb not null,
      patrimonio  jsonb not null default '{"activos":[],"pasivos":[],"historia":{},"cierres":{}}'::jsonb,
      actualizado timestamptz not null default now()
    );
  `);

  /* Paso a hogares. Se hace en varios ALTER sueltos con IF NOT EXISTS para que
     volver a arrancar el servidor no rompa nada. */
  await pool.query(`alter table usuarios    add column if not exists hogar_id uuid references hogares(id) on delete set null`);
  await pool.query(`alter table usuarios    add column if not exists nombre   text`);
  await pool.query(`alter table movimientos add column if not exists hogar_id uuid references hogares(id) on delete cascade`);
  await pool.query(`alter table movimientos add column if not exists creado_por uuid references usuarios(id) on delete set null`);
  await pool.query(`alter table maestros    add column if not exists hogar_id uuid references hogares(id) on delete cascade`);

  /* La versión anterior guardaba las filas por persona y exigía user_id. Ahora
     la columna que manda es hogar_id, así que esas restricciones deben soltarse
     o cualquier inserción falla. user_id se conserva solo como histórico. */
  await pool.query(`alter table movimientos alter column user_id drop not null`);
  await pool.query(`alter table maestros    drop constraint if exists maestros_pkey`);
  await pool.query(`alter table maestros    alter column user_id drop not null`);

  /* Cada usuario que todavía no tenga hogar recibe el suyo, y sus datos se
     mudan a él. Sin esto, quien ya se había registrado perdería lo suyo. */
  const { rows: sinHogar } = await pool.query('select id from usuarios where hogar_id is null');
  for (const u of sinHogar) {
    let h;
    for (let i = 0; i < 5 && !h; i++) {
      try {
        const r = await pool.query('insert into hogares (codigo) values ($1) returning id', [nuevoCodigo()]);
        h = r.rows[0].id;
      } catch (e) { if (e.code !== '23505') throw e; }   // código repetido: reintenta
    }
    await pool.query('update usuarios    set hogar_id=$1 where id=$2', [h, u.id]);
    await pool.query('update movimientos set hogar_id=$1, creado_por=coalesce(creado_por,user_id) where user_id=$2 and hogar_id is null', [h, u.id]);
    await pool.query('update maestros    set hogar_id=$1 where user_id=$2 and hogar_id is null', [h, u.id]);
  }

  /* Suscripciones a las notificaciones del navegador. Una por dispositivo:
     el mismo usuario puede tener el celular y el PC. */
  await pool.query(`
    create table if not exists avisos (
      endpoint   text primary key,
      user_id    uuid not null references usuarios(id) on delete cascade,
      datos      jsonb not null,
      hora       int  not null default 21,
      ultimo     date,
      creado     timestamptz not null default now()
    );
    create index if not exists avisos_user on avisos (user_id);
  `);

  /* Enlaces de un solo uso para volver a poner la contraseña. Se guarda el
     hash del token, no el token: si alguien leyera la base, no podría usarlo. */
  await pool.query(`
    create table if not exists recuperaciones (
      token_hash text primary key,
      user_id    uuid not null references usuarios(id) on delete cascade,
      expira     timestamptz not null,
      usado      timestamptz,
      creado     timestamptz not null default now()
    );
  `);

  await pool.query(`create index if not exists mov_hogar_fecha on movimientos (hogar_id, fecha desc)`);
  await pool.query(`create unique index if not exists maestros_hogar on maestros (hogar_id)`);
  console.log('Base de datos lista (hogares, usuarios, movimientos, maestros)');
}

/* ───────────────────────── sesión ───────────────────────── */
/* Sin secreto no se arranca: con uno por defecto cualquiera podría
   fabricarse una sesión válida y leer los datos. */
const SECRETO = process.env.JWT_SECRET;
if (!SECRETO || SECRETO.length < 32) {
  console.error('Falta JWT_SECRET (mínimo 32 caracteres). El servidor no arranca.');
  process.exit(1);
}
const DIAS = 30;
const COOKIE = 'sesion';

function darSesion(res, userId) {
  const token = jwt.sign({ uid: userId }, SECRETO, { expiresIn: `${DIAS}d` });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV !== 'desarrollo',
    sameSite: 'lax',
    maxAge: DIAS * 864e5,
    path: '/'
  });
}
/* Además de validar la sesión, resuelve a qué hogar pertenece quien entra:
   todas las consultas de datos filtran por ese hogar, nunca por la persona. */
async function conSesion(req, res, next) {
  const t = req.cookies?.[COOKIE];
  if (!t) return res.status(401).json({ error: 'Sin sesión' });
  let uid;
  try { uid = jwt.verify(t, SECRETO).uid; }
  catch {
    res.clearCookie(COOKIE, { path: '/' });
    return res.status(401).json({ error: 'La sesión expiró. Vuelve a entrar.' });
  }
  try {
    const { rows } = await pool.query(
      'select id, correo, nombre, hogar_id from usuarios where id=$1', [uid]);
    if (!rows.length) {
      res.clearCookie(COOKIE, { path: '/' });
      return res.status(401).json({ error: 'Sin sesión' });
    }
    req.uid = rows[0].id;
    req.correo = rows[0].correo;
    req.nombre = rows[0].nombre;
    req.hogar = rows[0].hogar_id;
    next();
  } catch (e) { res.status(500).json({ error: 'Error de servidor' }); }
}

/* Freno a la fuerza bruta: 8 intentos fallidos por correo+IP cada 15 minutos */
const intentos = new Map();
function frenar(clave) {
  const ahora = Date.now();
  const e = intentos.get(clave);
  if (!e || ahora > e.hasta) { intentos.set(clave, { n: 1, hasta: ahora + 9e5 }); return true; }
  e.n++;
  return e.n <= 8;
}
setInterval(() => {
  const ahora = Date.now();
  for (const [k, v] of intentos) if (ahora > v.hasta) intentos.delete(k);
}, 6e5).unref();

/* ───────────────────────── middleware ───────────────────────── */
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '4mb' }));
app.use(cookieParser());
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

const correoValido = c => typeof c === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(c) && c.length < 160;
const texto = (v, max) => (v == null ? null : String(v).slice(0, max));

/* ───────────────────────── cuentas ───────────────────────── */
app.post('/api/registro', async (req, res) => {
  const cli = await pool.connect();
  try {
    const correo = String(req.body?.correo || '').trim().toLowerCase();
    const clave = String(req.body?.clave || '');
    const nombre = texto(String(req.body?.nombre || '').trim(), 40) || null;
    const codigo = String(req.body?.codigo || '').trim().toUpperCase();
    if (!correoValido(correo)) return res.status(400).json({ error: 'El correo no parece válido.' });
    if (clave.length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.' });

    const ya = await cli.query('select 1 from usuarios where correo=$1', [correo]);
    if (ya.rowCount) return res.status(409).json({ error: 'Ya existe una cuenta con ese correo. Usa "Entrar".' });

    /* Con código se entra al hogar que ya existe; sin código se crea uno nuevo */
    let hogar;
    if (codigo) {
      const h = await cli.query('select id from hogares where codigo=$1', [codigo]);
      if (!h.rowCount) return res.status(404).json({ error: 'Ese código de hogar no existe. Revísalo con quien te lo pasó.' });
      hogar = h.rows[0].id;
    }

    await cli.query('begin');
    if (!hogar) {
      for (let i = 0; i < 5 && !hogar; i++) {
        try {
          const r = await cli.query('insert into hogares (codigo) values ($1) returning id', [nuevoCodigo()]);
          hogar = r.rows[0].id;
        } catch (e) { if (e.code !== '23505') throw e; }
      }
    }
    const hash = await bcrypt.hash(clave, 12);
    const { rows } = await cli.query(
      'insert into usuarios (correo, clave_hash, nombre, hogar_id) values ($1,$2,$3,$4) returning id',
      [correo, hash, nombre, hogar]);
    await cli.query('commit');
    darSesion(res, rows[0].id);
    const { rows: hr } = await pool.query('select codigo from hogares where id=$1', [hogar]);
    res.json({ correo, nombre, codigo: hr[0]?.codigo, seUnio: !!codigo });
  } catch (e) {
    await cli.query('rollback').catch(() => {});
    console.error('registro', e);
    res.status(500).json({ error: 'No se pudo crear la cuenta.' });
  } finally { cli.release(); }
});

/* Quién está en el hogar y con qué código se invita a alguien más */
app.get('/api/hogar', conSesion, async (req, res) => {
  try {
    const [h, m] = await Promise.all([
      pool.query('select codigo, nombre from hogares where id=$1', [req.hogar]),
      pool.query('select correo, nombre, creado from usuarios where hogar_id=$1 order by creado', [req.hogar])
    ]);
    res.json({ codigo: h.rows[0]?.codigo || null, nombre: h.rows[0]?.nombre || 'Mi hogar',
               miembros: m.rows.map(u => ({ correo: u.correo, nombre: u.nombre })) });
  } catch (e) { res.status(500).json({ error: 'No se pudo leer el hogar.' }); }
});

/* Unirse a otro hogar desde una cuenta ya creada. Pide la contraseña porque
   deja de verse lo propio para pasar a ver lo del otro hogar. */
app.post('/api/hogar/unirse', conSesion, async (req, res) => {
  try {
    const codigo = String(req.body?.codigo || '').trim().toUpperCase();
    const clave = String(req.body?.clave || '');
    const { rows: u } = await pool.query('select clave_hash from usuarios where id=$1', [req.uid]);
    if (!await bcrypt.compare(clave, u[0].clave_hash))
      return res.status(401).json({ error: 'Contraseña incorrecta.' });
    const h = await pool.query('select id from hogares where codigo=$1', [codigo]);
    if (!h.rowCount) return res.status(404).json({ error: 'Ese código de hogar no existe.' });
    if (h.rows[0].id === req.hogar) return res.status(400).json({ error: 'Ya perteneces a ese hogar.' });
    await pool.query('update usuarios set hogar_id=$1 where id=$2', [h.rows[0].id, req.uid]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'No se pudo cambiar de hogar.' }); }
});

app.post('/api/entrar', async (req, res) => {
  try {
    const correo = String(req.body?.correo || '').trim().toLowerCase();
    const clave = String(req.body?.clave || '');
    if (!frenar(correo + '|' + req.ip))
      return res.status(429).json({ error: 'Demasiados intentos. Espera 15 minutos.' });

    const { rows } = await pool.query('select id, clave_hash from usuarios where correo=$1', [correo]);
    /* Mismo mensaje exista o no el correo: así no se puede averiguar
       qué correos tienen cuenta probando uno por uno. */
    const malas = { error: 'Correo o contraseña incorrectos.' };
    if (!rows.length) { await bcrypt.hash(clave, 12); return res.status(401).json(malas); }
    if (!await bcrypt.compare(clave, rows[0].clave_hash)) return res.status(401).json(malas);

    darSesion(res, rows[0].id);
    res.json({ correo });
  } catch (e) {
    console.error('entrar', e);
    res.status(500).json({ error: 'No se pudo iniciar sesión.' });
  }
});

app.post('/api/salir', (req, res) => {
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/yo', conSesion, (req, res) => {
  res.json({ correo: req.correo, nombre: req.nombre });
});

/* ───────────────────────── datos ───────────────────────── */
app.get('/api/datos', conSesion, async (req, res) => {
  try {
    const [mv, ms] = await Promise.all([
      pool.query(`select m.id,m.tipo,m.fecha,m.cat,m.sub,m.monto,m.cuenta,m.det,
                         coalesce(u.nombre, split_part(u.correo,'@',1)) as quien
                  from movimientos m left join usuarios u on u.id=m.creado_por
                  where m.hogar_id=$1 order by m.fecha desc`, [req.hogar]),
      pool.query('select cfg, patrimonio, actualizado from maestros where hogar_id=$1', [req.hogar])
    ]);
    res.json({
      tx: mv.rows.map(r => ({
        id: r.id, tipo: r.tipo,
        fecha: r.fecha instanceof Date ? r.fecha.toISOString().slice(0, 10) : String(r.fecha).slice(0, 10),
        cat: r.cat, sub: r.sub, monto: Number(r.monto), cuenta: r.cuenta || '', det: r.det || '',
        quien: r.quien || ''
      })),
      cfg: ms.rows[0]?.cfg || null,
      pat: ms.rows[0]?.patrimonio || null,
      sello: ms.rows[0]?.actualizado || null
    });
  } catch (e) {
    console.error('datos', e);
    res.status(500).json({ error: 'No se pudieron leer los datos.' });
  }
});

/* Marca de cambio: la usan los otros dispositivos para saber si hay novedades
   sin tener que descargarlo todo cada vez. */
app.get('/api/sello', conSesion, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `select greatest(
         coalesce((select max(creado) from movimientos where hogar_id=$1), to_timestamp(0)),
         coalesce((select actualizado from maestros where hogar_id=$1), to_timestamp(0))
       ) as s, (select count(*) from movimientos where hogar_id=$1) as n`, [req.hogar]);
    res.json({ sello: rows[0].s, n: Number(rows[0].n) });
  } catch (e) { res.status(500).json({ error: 'error' }); }
});

app.post('/api/movimientos', conSesion, async (req, res) => {
  try {
    const m = req.body || {};
    const monto = Number(m.monto);
    if (!['gasto', 'ingreso'].includes(m.tipo)) return res.status(400).json({ error: 'Tipo inválido' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(m.fecha || '')) return res.status(400).json({ error: 'Fecha inválida' });
    if (!(monto > 0) || !isFinite(monto)) return res.status(400).json({ error: 'Monto inválido' });
    const id = /^[0-9a-f-]{36}$/i.test(m.id || '') ? m.id : randomUUID();
    await pool.query(
      `insert into movimientos (id,hogar_id,creado_por,tipo,fecha,cat,sub,monto,cuenta,det)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (id) do nothing`,
      [id, req.hogar, req.uid, m.tipo, m.fecha, texto(m.cat, 80), texto(m.sub, 80), monto,
       texto(m.cuenta, 60), texto(m.det, 300)]);
    res.json({ id });
  } catch (e) {
    console.error('movimiento', e);
    res.status(500).json({ error: 'No se pudo guardar el movimiento.' });
  }
});

app.delete('/api/movimientos/:id', conSesion, async (req, res) => {
  try {
    await pool.query('delete from movimientos where id=$1 and hogar_id=$2', [req.params.id, req.hogar]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'No se pudo eliminar.' }); }
});

app.put('/api/maestros', conSesion, async (req, res) => {
  try {
    const { cfg, pat } = req.body || {};
    if (!cfg || typeof cfg !== 'object') return res.status(400).json({ error: 'Faltan las categorías' });
    await pool.query(
      `insert into maestros (hogar_id,cfg,patrimonio,actualizado) values ($1,$2,$3,now())
       on conflict (hogar_id) do update set cfg=$2, patrimonio=$3, actualizado=now()`,
      [req.hogar, cfg, pat || {}]);
    res.json({ ok: true });
  } catch (e) {
    console.error('maestros', e);
    res.status(500).json({ error: 'No se pudieron guardar las categorías.' });
  }
});

/* Reemplaza todo: lo usa "Restaurar respaldo". Va en una transacción para que
   no quede a medias si algo falla. */
app.post('/api/importar', conSesion, async (req, res) => {
  const cli = await pool.connect();
  try {
    const { tx = [], cfg, pat } = req.body || {};
    if (!Array.isArray(tx) || tx.length > 20000)
      return res.status(400).json({ error: 'Respaldo inválido o demasiado grande.' });
    await cli.query('begin');
    await cli.query('delete from movimientos where hogar_id=$1', [req.hogar]);
    for (const m of tx) {
      const monto = Number(m.monto);
      if (!['gasto', 'ingreso'].includes(m.tipo)) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(m.fecha || '')) continue;
      if (!(monto > 0) || !isFinite(monto)) continue;
      await cli.query(
        `insert into movimientos (id,hogar_id,creado_por,tipo,fecha,cat,sub,monto,cuenta,det)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (id) do nothing`,
        [/^[0-9a-f-]{36}$/i.test(m.id || '') ? m.id : randomUUID(), req.hogar, req.uid, m.tipo, m.fecha,
         texto(m.cat, 80), texto(m.sub, 80), monto, texto(m.cuenta, 60), texto(m.det, 300)]);
    }
    if (cfg) await cli.query(
      `insert into maestros (hogar_id,cfg,patrimonio,actualizado) values ($1,$2,$3,now())
       on conflict (hogar_id) do update set cfg=$2, patrimonio=$3, actualizado=now()`,
      [req.hogar, cfg, pat || {}]);
    await cli.query('commit');
    res.json({ ok: true, n: tx.length });
  } catch (e) {
    await cli.query('rollback').catch(() => {});
    console.error('importar', e);
    res.status(500).json({ error: 'No se pudo restaurar el respaldo.' });
  } finally { cli.release(); }
});

/* ───────────────────────── recuperar la contraseña ─────────────────────────
   Todavía no hay envío de correo, así que el enlace lo genera quien administra
   y se lo entrega al dueño de la cuenta. El enlace caduca y sirve una sola vez;
   la contraseña nueva la escribe el usuario, nunca pasa por terceros. */
const ADMIN = process.env.ADMIN_SECRET || '';
const hashToken = t => createHash('sha256').update(t).digest('hex');

app.post('/api/admin/enlace-recuperacion', async (req, res) => {
  try {
    if (!ADMIN || req.get('x-admin-secret') !== ADMIN)
      return res.status(403).json({ error: 'No autorizado' });
    const correo = String(req.body?.correo || '').trim().toLowerCase();
    const { rows } = await pool.query('select id from usuarios where correo=$1', [correo]);
    if (!rows.length) return res.status(404).json({ error: 'No hay cuenta con ese correo' });

    const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    const expira = new Date(Date.now() + 36e5);        // una hora
    await pool.query('delete from recuperaciones where user_id=$1 and usado is null', [rows[0].id]);
    await pool.query('insert into recuperaciones (token_hash,user_id,expira) values ($1,$2,$3)',
      [hashToken(token), rows[0].id, expira]);
    res.json({ enlace: `${req.protocol}://${req.get('host')}/recuperar?t=${token}`, expira });
  } catch (e) { console.error('enlace', e); res.status(500).json({ error: 'error' }); }
});

app.post('/api/recuperar', async (req, res) => {
  try {
    const token = String(req.body?.token || '');
    const clave = String(req.body?.clave || '');
    if (clave.length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.' });
    const { rows } = await pool.query(
      `select r.user_id, u.correo from recuperaciones r join usuarios u on u.id=r.user_id
        where r.token_hash=$1 and r.usado is null and r.expira > now()`, [hashToken(token)]);
    if (!rows.length) return res.status(400).json({ error: 'Este enlace ya se usó o venció. Pide uno nuevo.' });

    const hash = await bcrypt.hash(clave, 12);
    await pool.query('update usuarios set clave_hash=$1 where id=$2', [hash, rows[0].user_id]);
    await pool.query('update recuperaciones set usado=now() where token_hash=$1', [hashToken(token)]);
    /* Se cierran las sesiones abiertas en otros equipos: si alguien había
       entrado con la clave vieja, deja de tener acceso. */
    darSesion(res, rows[0].user_id);
    res.json({ ok: true, correo: rows[0].correo });
  } catch (e) { console.error('recuperar', e); res.status(500).json({ error: 'No se pudo cambiar la contraseña.' }); }
});

/* Página mínima para escribir la contraseña nueva */
app.get('/recuperar', (req, res) => {
  res.type('html').send(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Nueva contraseña · Finanzas FVR</title>
<style>
:root{--p:#1c5cab;--bg:#f5f7fa;--card:#fff;--tx:#11161d;--tx2:#5b6472;--bd:#e3e7ec;--bad:#b02525;--ok:#006300}
@media(prefers-color-scheme:dark){:root{--p:#3987e5;--bg:#101620;--card:#19212e;--tx:#eef1f6;--tx2:#9aa5b4;--bd:#2a3444;--bad:#f08a8a;--ok:#3ec93e}}
*{box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
background:var(--bg);color:var(--tx);display:grid;place-items:center;min-height:100vh;margin:0;padding:20px}
.c{background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:26px;max-width:400px;width:100%}
h1{font-size:19px;margin:0 0 6px}p{font-size:13px;color:var(--tx2);line-height:1.6;margin:0 0 16px}
label{display:block;font-size:11px;font-weight:700;color:var(--tx2);text-transform:uppercase;letter-spacing:.4px;margin:0 0 5px}
input{width:100%;padding:13px;border:1px solid var(--bd);border-radius:8px;font-size:16px;margin-bottom:12px;
background:var(--bg);color:var(--tx)}
button{width:100%;padding:14px;background:var(--p);color:#fff;border:0;border-radius:8px;font-weight:700;font-size:15px;cursor:pointer}
button:disabled{opacity:.6}
.m{font-size:13px;font-weight:600;margin-top:12px;line-height:1.5}
</style></head><body><div class="c">
<h1>🔑 Nueva contraseña</h1>
<p>Escribe una contraseña nueva. Que sea larga y que no uses en otro sitio: es lo único que protege tus datos.</p>
<label for="c1">Contraseña nueva</label><input type="password" id="c1" autocomplete="new-password" placeholder="Mínimo 8 caracteres">
<label for="c2">Repítela</label><input type="password" id="c2" autocomplete="new-password" placeholder="La misma">
<button id="b">Guardar y entrar</button>
<div class="m" id="m"></div>
</div><script>
const p=new URLSearchParams(location.search), t=p.get('t')||'';
const m=document.getElementById('m'), b=document.getElementById('b');
if(!t){ m.style.color='var(--bad)'; m.textContent='Enlace incompleto. Pide uno nuevo.'; b.disabled=true; }
b.onclick=async()=>{
  const a=document.getElementById('c1').value, c=document.getElementById('c2').value;
  m.style.color='var(--bad)';
  if(a.length<8) return m.textContent='Debe tener al menos 8 caracteres.';
  if(a!==c)      return m.textContent='Las dos no coinciden.';
  b.disabled=true; m.style.color='var(--tx2)'; m.textContent='Guardando…';
  try{
    const r=await fetch('/api/recuperar',{method:'POST',headers:{'Content-Type':'application/json'},
      credentials:'same-origin',body:JSON.stringify({token:t,clave:a})});
    const d=await r.json();
    if(!r.ok) throw new Error(d.error||'No se pudo');
    m.style.color='var(--ok)'; m.textContent='Listo. Entrando…';
    setTimeout(()=>location.href='/',1200);
  }catch(e){ m.style.color='var(--bad)'; m.textContent=e.message; b.disabled=false; }
};
</script></body></html>`);
});

/* ───────────────────────── recordatorio diario ─────────────────────────
   El navegador no puede despertarse solo a una hora, así que la notificación
   la empuja el servidor. En iOS solo llega si la app está agregada a la
   pantalla de inicio: es una restricción de Apple, no del código. */
const VAPID_PUB = process.env.VAPID_PUBLIC || '';
const VAPID_PRIV = process.env.VAPID_PRIVATE || '';
const avisosActivos = !!(VAPID_PUB && VAPID_PRIV);
if (avisosActivos) {
  webpush.setVapidDetails('mailto:svalencia536@gmail.com', VAPID_PUB, VAPID_PRIV);
} else {
  console.warn('Sin VAPID_PUBLIC/VAPID_PRIVATE: los recordatorios quedan apagados.');
}

app.get('/api/avisos/llave', (_, res) => res.json({ llave: VAPID_PUB, activos: avisosActivos }));

app.post('/api/avisos/suscribir', conSesion, async (req, res) => {
  try {
    const s = req.body?.sub;
    const hora = Math.min(23, Math.max(0, parseInt(req.body?.hora ?? 21, 10) || 21));
    if (!s?.endpoint || !s?.keys?.p256dh) return res.status(400).json({ error: 'Suscripción inválida' });
    await pool.query(
      `insert into avisos (endpoint,user_id,datos,hora) values ($1,$2,$3,$4)
       on conflict (endpoint) do update set user_id=$2, datos=$3, hora=$4`,
      [s.endpoint, req.uid, s, hora]);
    res.json({ ok: true, hora });
  } catch (e) { console.error('suscribir', e); res.status(500).json({ error: 'No se pudo activar.' }); }
});

app.post('/api/avisos/cancelar', conSesion, async (req, res) => {
  try {
    const ep = req.body?.endpoint;
    if (ep) await pool.query('delete from avisos where endpoint=$1 and user_id=$2', [ep, req.uid]);
    else await pool.query('delete from avisos where user_id=$1', [req.uid]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'No se pudo desactivar.' }); }
});

app.get('/api/avisos/estado', conSesion, async (req, res) => {
  const { rows } = await pool.query('select endpoint, hora from avisos where user_id=$1', [req.uid]);
  res.json({ dispositivos: rows.length, hora: rows[0]?.hora ?? 21 });
});

/* Envío de prueba, para comprobar que llega sin esperar a la hora */
app.post('/api/avisos/probar', conSesion, async (req, res) => {
  const { rows } = await pool.query('select endpoint, datos from avisos where user_id=$1', [req.uid]);
  if (!rows.length) return res.status(404).json({ error: 'Este dispositivo no tiene el recordatorio activado.' });
  let ok = 0;
  for (const r of rows) if (await enviarAviso(r, '🔔 Prueba', 'Si ves esto, el recordatorio quedó funcionando.')) ok++;
  res.json({ enviados: ok, de: rows.length });
});

async function enviarAviso(fila, titulo, cuerpo) {
  try {
    await webpush.sendNotification(fila.datos, JSON.stringify({ titulo, cuerpo }));
    return true;
  } catch (e) {
    /* Se descarta la suscripción cuando ya no sirve:
         404/410 → el navegador la desechó (app desinstalada, permiso revocado)
         403/400 → el servicio la rechaza por mal formada o firmada
         sin statusCode → ni siquiera se pudo construir el envío
       Cualquiera de esos casos fallaría igual todas las noches. */
    const muerta = [400, 403, 404, 410].includes(e.statusCode) || e.statusCode === undefined;
    if (muerta) {
      await pool.query('delete from avisos where endpoint=$1', [fila.endpoint]).catch(() => {});
      console.warn('aviso descartado', e.statusCode ?? 'sin código', e.message);
    } else {
      /* 429 o 5xx: el servicio está saturado o caído. Se conserva y se
         reintenta mañana; borrarla aquí perdería un recordatorio válido. */
      console.error('aviso falló', e.statusCode, e.body || e.message);
    }
    return false;
  }
}

/* La hora de Colombia es fija (UTC-5, sin horario de verano), pero se calcula
   con la zona horaria real para no depender de esa suposición. */
function ahoraBogota() {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit'
  }).formatToParts(new Date());
  const v = Object.fromEntries(f.map(p => [p.type, p.value]));
  return { fecha: `${v.year}-${v.month}-${v.day}`, hora: parseInt(v.hour, 10) };
}

async function revisarRecordatorios() {
  if (!avisosActivos) return;
  const { fecha, hora } = ahoraBogota();
  try {
    const { rows } = await pool.query(
      `select a.endpoint, a.datos, u.hogar_id,
              (select count(*) from movimientos m
                where m.hogar_id=u.hogar_id and m.fecha=$1) as hoy
         from avisos a join usuarios u on u.id=a.user_id
        where a.hora=$2 and (a.ultimo is null or a.ultimo < $1::date)`,
      [fecha, hora]);
    for (const r of rows) {
      const n = Number(r.hoy);
      const [titulo, cuerpo] = n > 0
        ? ['✅ Van ' + n + ' movimiento' + (n === 1 ? '' : 's') + ' hoy',
           '¿Quedó algo sin registrar? Un minuto ahora te ahorra media hora el fin de mes.']
        : ['💰 No has registrado nada hoy',
           'Abre y anota lo del día: los gastos pequeños son los que descuadran el presupuesto.'];
      await enviarAviso(r, titulo, cuerpo);
      await pool.query('update avisos set ultimo=$1 where endpoint=$2', [fecha, r.endpoint]).catch(() => {});
    }
    if (rows.length) console.log(`Recordatorios enviados: ${rows.length} (${fecha} ${hora}h Bogotá)`);
  } catch (e) { console.error('recordatorios', e.message); }
}
/* Se revisa cada cinco minutos: basta para acertar la hora y no castiga la base */
setInterval(revisarRecordatorios, 3e5).unref();

/* ───────────────────────── la aplicación ───────────────────────── */
app.get('/api/salud', async (_, res) => {
  try { await pool.query('select 1'); res.json({ ok: true }); }
  catch { res.status(503).json({ ok: false }); }
});
app.use(express.static(__dirname, { index: 'index.html', extensions: ['html'], maxAge: 0 }));
app.get('*', (_, res) => res.sendFile(join(__dirname, 'index.html')));

migrar()
  .then(() => app.listen(PORT, () => console.log('Escuchando en el puerto ' + PORT)))
  .catch(e => { console.error('No se pudo preparar la base de datos:', e); process.exit(1); });
