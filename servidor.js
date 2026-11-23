/*
  Servidor-ponte - Ar-condicionados BFT

  Por que existe: o ESP32 não tem IP fixo (muda de rede o tempo todo) e não
  aceita conexão de fora da rede local dele. Em vez do site falar direto com
  o ESP, os dois falam com ESTE servidor, que fica num endereço fixo na nuvem:

    Site (navegador) <--HTTPS--> ESTE SERVIDOR <--HTTPS (o ESP puxa)--> ESP32

  O ESP nunca recebe conexão de fora - ele só CONSULTA este servidor de
  tempos em tempos (poll), pergunta "tem comando novo?" e informa seu estado
  atual. Isso funciona em qualquer rede Wi-Fi, mesmo as que bloqueiam conexão
  direta entre aparelhos (hotspot de celular, etc).

  Estado fica em memória (não salva em banco) - reinicia zerado se o Render
  reiniciar o serviço (acontece raramente, só em deploy novo ou após dormir
  por inatividade no plano grátis).
*/

const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// CORS liberado pra tudo (o site roda em outra origem - GitHub Pages)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ===================== ESTADO (em memória, por sala) =====================
const ADMIN_SENHA_PADRAO = 'admin123';
let adminSenha = ADMIN_SENHA_PADRAO;
const tokens = new Set();

// Cada sala: o que o SITE pediu (desejado) x o que o ESP confirmou (aplicado).
// seq sobe a cada pedido novo - o ESP compara com o que já aplicou por último.
const salas = new Map(); // id -> { desejado: {ligado, temperatura, seq}, aplicado: {...}, ultimoContato }

function getSala(id) {
  if (!salas.has(id)) {
    salas.set(id, {
      desejado: { ligado: false, temperatura: 22, seq: 0 },
      aplicado: { ligado: false, temperatura: 22, seq: -1 },
      agendaDesejada: null,
      agendaAplicada: null,
      ultimoContato: 0
    });
  }
  return salas.get(id);
}

const online = sala => !!(sala.ultimoContato && (Date.now() - sala.ultimoContato) < 15000);
const autenticado = req => {
  const t = req.header('X-Admin-Token');
  return !!t && tokens.has(t);
};

// ===================== API PRO SITE (mesmo contrato do ESP local) =====================
app.get('/sala/:id/estado', (req, res) => {
  const sala = getSala(req.params.id);
  res.json({ id: req.params.id, ligado: sala.aplicado.ligado, temperatura: sala.aplicado.temperatura, online: online(sala) });
});

app.post('/sala/:id/ligar', (req, res) => {
  const sala = getSala(req.params.id);
  const temp = Number.isInteger(req.body.temperatura) ? req.body.temperatura : sala.aplicado.temperatura;
  if (temp < 18 || temp > 24) return res.status(400).json({ erro: 'Temperatura inválida' });
  sala.desejado = { ligado: true, temperatura: temp, seq: sala.desejado.seq + 1 };
  res.json({ id: req.params.id, ligado: true, temperatura: temp });
});

app.post('/sala/:id/desligar', (req, res) => {
  const sala = getSala(req.params.id);
  sala.desejado = { ligado: false, temperatura: sala.desejado.temperatura, seq: sala.desejado.seq + 1 };
  res.json({ id: req.params.id, ligado: false, temperatura: sala.aplicado.temperatura });
});

app.post('/sala/:id/temperatura', (req, res) => {
  const sala = getSala(req.params.id);
  const temp = req.body.temperatura;
  if (!Number.isInteger(temp) || temp < 18 || temp > 24) return res.status(400).json({ erro: 'Temperatura inválida' });
  if (!sala.aplicado.ligado) return res.status(409).json({ erro: 'Sala desligada' });
  sala.desejado = { ligado: true, temperatura: temp, seq: sala.desejado.seq + 1 };
  res.json({ id: req.params.id, ligado: sala.aplicado.ligado, temperatura: temp });
});

app.post('/admin/login', (req, res) => {
  if (req.body.senha !== adminSenha) return res.status(401).json({ erro: 'Senha incorreta' });
  const token = crypto.randomBytes(16).toString('hex');
  tokens.add(token);
  res.json({ token });
});

app.post('/admin/senha', (req, res) => {
  if (!autenticado(req)) return res.status(401).json({ erro: 'Não autenticado' });
  const { atual, nova } = req.body;
  if (atual !== adminSenha) return res.status(403).json({ erro: 'Senha atual incorreta' });
  if (!nova || nova.length < 4 || nova.length > 32) return res.status(400).json({ erro: 'Nova senha inválida (4-32 caracteres)' });
  adminSenha = nova;
  res.json({ ok: true });
});

app.get('/admin/agenda', (req, res) => {
  if (!autenticado(req)) return res.status(401).json({ erro: 'Não autenticado' });
  const sala = getSala(req.query.sala || '6');
  res.json(sala.agendaAplicada || {});
});

app.post('/admin/agenda', (req, res) => {
  if (!autenticado(req)) return res.status(401).json({ erro: 'Não autenticado' });
  const sala = getSala(req.query.sala || req.body.sala || '6');
  sala.agendaDesejada = req.body;
  res.json({ ok: true });
});

// ===================== API PRO ESP (ele consulta isso sozinho) =====================
// O ESP faz GET nisso a cada poucos segundos perguntando "o que eu devo fazer".
app.get('/dispositivo/:id/comando', (req, res) => {
  const sala = getSala(req.params.id);
  sala.ultimoContato = Date.now();
  res.json({ desejado: sala.desejado, agendaDesejada: sala.agendaDesejada });
});

// O ESP manda isso depois de executar, confirmando o que realmente aplicou.
app.post('/dispositivo/:id/estado', (req, res) => {
  const sala = getSala(req.params.id);
  sala.ultimoContato = Date.now();
  if (req.body.aplicado) sala.aplicado = req.body.aplicado;
  if (req.body.agendaAplicada) sala.agendaAplicada = req.body.agendaAplicada;
  res.json({ ok: true });
});

app.get('/', (req, res) => {
  res.type('text/plain').send('Servidor-ponte BFT no ar.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor-ponte rodando na porta ${PORT}`));
