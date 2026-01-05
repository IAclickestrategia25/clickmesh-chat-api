const express = require("express");
const cors = require("cors");
require("dotenv").config();

const OpenAI = require("openai");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(cors());
app.use(express.json());

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Memoria simple en RAM (vale para MVP). En producción se suele pasar a BD/Redis.
const sessions = new Map(); // sessionId -> [{role, content}, ...]

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
- Si hay dudas sobre datosC, LOPDGDD o RGPD, responde de forma general y sugiere consulta profesional.

Importante:
- Si el usuario aporta datos personales, trátalos con discreción y no los repitas innecesariamente.
`;
}

app.get("/health", (req, res) => res.send("OK"));

app.post("/api/chat", async (req, res) => {
  try {
    const { message, sessionId } = req.body;

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ reply: "Falta configurar OPENAI_API_KEY en el servidor." });
    }

    const sid = sessionId || uuidv4();
    const history = sessions.get(sid) || [];

    // Limitamos historial para no crecer infinito
    const trimmedHistory = history.slice(-12);

    const messages = [
      { role: "system", content: systemPrompt() },
      ...trimmedHistory,
      { role: "user", content: String(message || "") },
    ];

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.35,
    });

    const reply = completion.choices?.[0]?.message?.content?.trim() || "No he podido responder ahora mismo.";

    // Guardar conversación en sesión
    const newHistory = [...trimmedHistory, { role: "user", content: String(message || "") }, { role: "assistant", content: reply }];
    sessions.set(sid, newHistory);

    res.json({ reply, sessionId: sid });
  } catch (e) {
    console.error(e);
    res.status(500).json({ reply: "Ha ocurrido un error. Inténtalo de nuevo en unos segundos." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API escuchando en http://localhost:${PORT}`));
