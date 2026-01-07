// server.js
// API Chat Clickmesh (Render) - versión endurecida para producción
// Requisitos env vars en Render:
// - OPENAI_API_KEY = tu clave de OpenAI
// - WIDGET_TOKEN   = token largo (mín. 32-64 caracteres) para autorizar el widget
// Opcional:
// - ALLOWED_ORIGINS = lista separada por comas de orígenes permitidos
//   ejemplo: https://automatizacionesbilbao.es,https://www.automatizacionesbilbao.es
// - PORT = lo pone Render automáticamente

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const OpenAI = require("openai");
const { v4: uuidv4 } = require("uuid");

const app = express();

// --- Seguridad básica HTTP ---
app.disable("x-powered-by");
app.use(
  helmet({
    // Para APIs suele ser mejor sin CSP estricta (no servimos HTML aquí)
    contentSecurityPolicy: false,
  })
);

// --- Body limit para evitar abusos ---
app.use(express.json({ limit: "16kb" }));

// --- CORS restringido ---
const defaultAllowed = [
  "https://automatizacionesbilbao.es",
  "https://www.automatizacionesbilbao.es",
];
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const finalAllowed = allowedOrigins.length ? allowedOrigins : defaultAllowed;

app.use(
  cors({
    origin: function (origin, cb) {
      // Permite llamadas sin Origin (Postman/cURL). Si quieres bloquearlas, quita este bloque.
      if (!origin) return cb(null, true);

      if (finalAllowed.includes(origin)) return cb(null, true);

      return cb(new Error("CORS: origen no permitido"));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Widget-Token"],
  })
);
app.options("*", cors());

// --- Rate limiting (protege contra abusos y gasto) ---
const chatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 20, // 20 req/min por IP
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/chat", chatLimiter);

// --- Cliente OpenAI ---
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Memoria simple en RAM (MVP). Si reinicia el servicio, se pierde (normal).
const sessions = new Map(); // sessionId -> [{role, content}, ...]

// --- Prompt del sistema ---
function systemPrompt() {
  return `
Eres el asistente de la web de Clickmesh (automatización y soluciones digitales).
Objetivo: resolver dudas y, cuando haya intención comercial, convertirla en lead cualificado.

Estilo:
- Profesional, claro, sin exageraciones.
- Respuestas directas, con pasos accionables.
- Si falta información, pregunta solo lo mínimo.

Reglas:
- No inventes precios, plazos, resultados garantizados ni tecnologías no confirmadas.
- Si el usuario pide presupuesto o muestra intención de contratar, debes pedir:
  (1) Nombre, (2) Empresa, (3) Email, (4) Teléfono, (5) Qué proceso quiere automatizar, (6) Herramientas que usa (si lo sabe).
- Si el usuario quiere hablar con una persona, ofrece contacto y sugiere agendar.
- Si la consulta es poco concreta, guía con 2-3 preguntas cerradas.
- Si hay dudas sobre datos, LOPDGDD o RGPD, responde de forma general y sugiere consulta profesional.

Importante:
- Si el usuario aporta datos personales, trátalos con discreción y no los repitas innecesariamente.
`;
}

// --- Health check ---
app.get("/health", (req, res) => res.status(200).send("OK"));

// --- Middleware: autenticación simple por token del widget ---
function requireWidgetToken(req, res, next) {
  const expected = process.env.WIDGET_TOKEN;

  // Si no has configurado WIDGET_TOKEN, mejor fallar explícitamente
  if (!expected) {
    return res
      .status(500)
      .json({ reply: "Falta configurar WIDGET_TOKEN en el servidor." });
  }

  const provided = req.headers["x-widget-token"];
  if (!provided || provided !== expected) {
    return res.status(401).json({ reply: "No autorizado." });
  }

  next();
}

// --- Endpoint chat ---
app.post("/api/chat", requireWidgetToken, async (req, res) => {
  try {
    const { message, sessionId } = req.body || {};

    if (!process.env.OPENAI_API_KEY) {
      return res
        .status(500)
        .json({ reply: "Falta configurar OPENAI_API_KEY en el servidor." });
    }

    const text = String(message || "").trim();
    if (!text) {
      return res.status(400).json({ reply: "Escribe un mensaje para poder ayudarte." });
    }

    // Limita longitud para evitar prompts gigantes
    if (text.length > 2000) {
      return res
        .status(400)
        .json({ reply: "El mensaje es demasiado largo. Resúmelo un poco, por favor." });
    }

    const sid = sessionId || uuidv4();
    const history = sessions.get(sid) || [];

    // Recortamos historial para no crecer sin control
    const trimmedHistory = history.slice(-12);

    const messages = [
      { role: "system", content: systemPrompt() },
      ...trimmedHistory,
      { role: "user", content: text },
    ];

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.35,
    });

    const reply =
      completion.choices?.[0]?.message?.content?.trim() ||
      "No he podido responder ahora mismo.";

    // Guardar conversación en sesión
    const newHistory = [
      ...trimmedHistory,
      { role: "user", content: text },
      { role: "assistant", content: reply },
    ];
    sessions.set(sid, newHistory);

    res.json({ reply, sessionId: sid });
  } catch (e) {
    console.error("Chat error:", e);
    res.status(500).json({ reply: "Ha ocurrido un error. Inténtalo de nuevo en unos segundos." });
  }
});

// --- Manejo de errores CORS (más claro) ---
app.use((err, req, res, next) => {
  if (String(err?.message || "").includes("CORS")) {
    return res.status(403).json({ reply: "Origen no permitido." });
  }
  next(err);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API escuchando en http://localhost:${PORT}`));
