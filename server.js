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
import { randomUUID } from 'node:crypto';
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

async function migrar() {
  await pool.query(`
    create table if not exists usuarios (
      id          uuid primary key default gen_random_uuid(),
      correo      text unique not null,
      clave_hash  text not null,
      creado      timestamptz not null default now()
    );
    create table if not exists movimientos (
      id       uuid primary key,
      user_id  uuid not null references usuarios(id) on delete cascade,
      tipo     text not null check (tipo in ('gasto','ingreso')),
      fecha    date not null,
      cat      text not null,
      sub      text not null,
      monto    numeric(14,2) not null check (monto > 0),
      cuenta   text,
      det      text,
      creado   timestamptz not null default now()
    );
    create index if not exists mov_user_fecha on movimientos (user_id, fecha desc);
    create table if not exists maestros (
      user_id     uuid primary key references usuarios(id) on delete cascade,
      cfg         jsonb not null,
      patrimonio  jsonb not null default '{"activos":[],"pasivos":[],"historia":{},"cierres":{}}'::jsonb,
      actualizado timestamptz not null default now()
    );
  `);
  console.log('Base de datos lista');
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
function conSesion(req, res, next) {
  const t = req.cookies?.[COOKIE];
  if (!t) return res.status(401).json({ error: 'Sin sesión' });
  try {
    req.uid = jwt.verify(t, SECRETO).uid;
    next();
  } catch {
    res.clearCookie(COOKIE, { path: '/' });
    res.status(401).json({ error: 'La sesión expiró. Vuelve a entrar.' });
  }
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
  try {
    const correo = String(req.body?.correo || '').trim().toLowerCase();
    const clave = String(req.body?.clave || '');
    if (!correoValido(correo)) return res.status(400).json({ error: 'El correo no parece válido.' });
    if (clave.length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.' });

    const ya = await pool.query('select 1 from usuarios where correo=$1', [correo]);
    if (ya.rowCount) return res.status(409).json({ error: 'Ya existe una cuenta con ese correo. Usa "Entrar".' });

    const hash = await bcrypt.hash(clave, 12);
    const { rows } = await pool.query(
      'insert into usuarios (correo, clave_hash) values ($1,$2) returning id', [correo, hash]);
    darSesion(res, rows[0].id);
    res.json({ correo });
  } catch (e) {
    console.error('registro', e);
    res.status(500).json({ error: 'No se pudo crear la cuenta.' });
  }
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

app.get('/api/yo', conSesion, async (req, res) => {
  const { rows } = await pool.query('select correo from usuarios where id=$1', [req.uid]);
  if (!rows.length) return res.status(401).json({ error: 'Sin sesión' });
  res.json({ correo: rows[0].correo });
});

/* ───────────────────────── datos ───────────────────────── */
app.get('/api/datos', conSesion, async (req, res) => {
  try {
    const [mv, ms] = await Promise.all([
      pool.query('select id,tipo,fecha,cat,sub,monto,cuenta,det from movimientos where user_id=$1 order by fecha desc', [req.uid]),
      pool.query('select cfg, patrimonio, actualizado from maestros where user_id=$1', [req.uid])
    ]);
    res.json({
      tx: mv.rows.map(r => ({
        id: r.id, tipo: r.tipo,
        fecha: r.fecha instanceof Date ? r.fecha.toISOString().slice(0, 10) : String(r.fecha).slice(0, 10),
        cat: r.cat, sub: r.sub, monto: Number(r.monto), cuenta: r.cuenta || '', det: r.det || ''
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
         coalesce((select max(creado) from movimientos where user_id=$1), to_timestamp(0)),
         coalesce((select actualizado from maestros where user_id=$1), to_timestamp(0))
       ) as s, (select count(*) from movimientos where user_id=$1) as n`, [req.uid]);
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
      `insert into movimientos (id,user_id,tipo,fecha,cat,sub,monto,cuenta,det)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (id) do nothing`,
      [id, req.uid, m.tipo, m.fecha, texto(m.cat, 80), texto(m.sub, 80), monto,
       texto(m.cuenta, 60), texto(m.det, 300)]);
    res.json({ id });
  } catch (e) {
    console.error('movimiento', e);
    res.status(500).json({ error: 'No se pudo guardar el movimiento.' });
  }
});

app.delete('/api/movimientos/:id', conSesion, async (req, res) => {
  try {
    await pool.query('delete from movimientos where id=$1 and user_id=$2', [req.params.id, req.uid]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'No se pudo eliminar.' }); }
});

app.put('/api/maestros', conSesion, async (req, res) => {
  try {
    const { cfg, pat } = req.body || {};
    if (!cfg || typeof cfg !== 'object') return res.status(400).json({ error: 'Faltan las categorías' });
    await pool.query(
      `insert into maestros (user_id,cfg,patrimonio,actualizado) values ($1,$2,$3,now())
       on conflict (user_id) do update set cfg=$2, patrimonio=$3, actualizado=now()`,
      [req.uid, cfg, pat || {}]);
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
    await cli.query('delete from movimientos where user_id=$1', [req.uid]);
    for (const m of tx) {
      const monto = Number(m.monto);
      if (!['gasto', 'ingreso'].includes(m.tipo)) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(m.fecha || '')) continue;
      if (!(monto > 0) || !isFinite(monto)) continue;
      await cli.query(
        `insert into movimientos (id,user_id,tipo,fecha,cat,sub,monto,cuenta,det)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (id) do nothing`,
        [/^[0-9a-f-]{36}$/i.test(m.id || '') ? m.id : randomUUID(), req.uid, m.tipo, m.fecha,
         texto(m.cat, 80), texto(m.sub, 80), monto, texto(m.cuenta, 60), texto(m.det, 300)]);
    }
    if (cfg) await cli.query(
      `insert into maestros (user_id,cfg,patrimonio,actualizado) values ($1,$2,$3,now())
       on conflict (user_id) do update set cfg=$2, patrimonio=$3, actualizado=now()`,
      [req.uid, cfg, pat || {}]);
    await cli.query('commit');
    res.json({ ok: true, n: tx.length });
  } catch (e) {
    await cli.query('rollback').catch(() => {});
    console.error('importar', e);
    res.status(500).json({ error: 'No se pudo restaurar el respaldo.' });
  } finally { cli.release(); }
});

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
