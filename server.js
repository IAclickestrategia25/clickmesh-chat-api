// server.js — Clickmesh Chat API (Render) con bloqueo de orígenes
// ENV en Render:
// OPENAI_API_KEY = ...
// WIDGET_TOKEN   = token largo
// (opcional) ALLOWED_ORIGINS = "https://automatizacionesbilbao.es,https://www.automatizacionesbilbao.es"

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const OpenAI = require("openai");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.disable("x-powered-by");

app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);

app.use(express.json({ limit: "16kb" }));

// =======================
// 1) LISTA BLANCA ORIGINS
// =======================
const defaultAllowed = new Set([
  "https://automatizacionesbilbao.es",
  "https://www.automatizacionesbilbao.es",
]);

const allowedFromEnv = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const allowedOrigins = new Set(
  allowedFromEnv.length ? allowedFromEnv : Array.from(defaultAllowed)
);

// Helper: ¿origin permitido?
function isAllowedOrigin(origin) {
  return origin && allowedOrigins.has(origin);
}

// ==================================
// 2) CORS SOLO PARA /api/* (recomendado)
// ==================================
app.use(
  "/api",
  cors({
    origin: (origin, cb) => {
      // Bloquea peticiones SIN origin para API (evita curl/postman/bots)
      if (!origin) return cb(new Error("CORS: missing origin"), false);

      if (isAllowedOrigin(origin)) return cb(null, true);

      return cb(new Error("CORS: origin not allowed"), false);
    },
    methods: ["POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Widget-Token"],
    credentials: false,
  })
);

// Preflight OPTIONS para /api/*
app.use("/api", (req, res, next) => {
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// =======================
// 3) RATE LIMIT
// =======================
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/chat", chatLimiter);

// =======================
// 4) OpenAI client
// =======================
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Sesiones en RAM
const sessions = new Map();

// =======================
// 5) Prompt del sistema
// =======================
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
- Si el usuario pide presupuesto o muestra intención de contratar, pide:
  (1) Nombre, (2) Empresa, (3) Email, (4) Teléfono, (5) Proceso a automatizar, (6) Herramientas que usa (si lo sabe).
- Si el usuario quiere hablar con una persona, ofrece contacto y sugiere agendar.
- Si la consulta es poco concreta, guía con 2-3 preguntas cerradas.
- Si hay dudas sobre LOPDGDD o RGPD, responde de forma general y sugiere consulta profesional.

Importante:
- Si el usuario aporta datos personales, trátalos con discreción y no los repitas innecesariamente.
`;
}

// =======================
// 6) Health check
// =======================
app.get("/health", (req, res) => res.status(200).send("OK"));

// =======================
// 7) Middleware token widget
// =======================
function requireWidgetToken(req, res, next) {
  const expected = process.env.WIDGET_TOKEN;
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

// =======================
// 8) Endpoint chat
// =======================
app.post("/api/chat", requireWidgetToken, async (req, res) => {
  try {
    // Extra hardening: valida origin también aquí (doble capa)
    const origin = req.headers.origin;
    if (!isAllowedOrigin(origin)) {
      return res.status(403).json({ reply: "Origen no permitido." });
    }

    const { message, sessionId } = req.body || {};

    if (!process.env.OPENAI_API_KEY) {
      return res
        .status(500)
        .json({ reply: "Falta configurar OPENAI_API_KEY en el servidor." });
    }

    const text = String(message || "").trim();
    if (!text) {
      return res
        .status(400)
        .json({ reply: "Escribe un mensaje para poder ayudarte." });
    }

    if (text.length > 2000) {
      return res.status(400).json({
        reply: "El mensaje es demasiado largo. Resúmelo un poco, por favor.",
      });
    }

    const sid = sessionId || uuidv4();
    const history = sessions.get(sid) || [];
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

    sessions.set(sid, [
      ...trimmedHistory,
      { role: "user", content: text },
      { role: "assistant", content: reply },
    ]);

    res.json({ reply, sessionId: sid });
  } catch (e) {
    console.error("Chat error:", e);
    res
      .status(500)
      .json({ reply: "Ha ocurrido un error. Inténtalo de nuevo en unos segundos." });
  }
});

// =======================
// 9) Errores CORS claros
// =======================
app.use((err, req, res, next) => {
  const msg = String(err?.message || "");
  if (msg.startsWith("CORS:")) {
    return res.status(403).json({ reply: "Origen no permitido." });
  }
  next(err);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API escuchando en http://localhost:${PORT}`));
