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

  Até 2 aparelhos por sala (ver HANDOFF.md): cada sala guarda `qtd` (1 ou 2)
  e `protocolos` (a marca de cada aparelho, string tipo "MIDEA"/"GREE"), e o
  `desejado`/`aplicado` viram um array `aparelhos: [{ligado,temperatura}, ...]`
  em vez de um único ligado/temperatura. `alvo` em `desejado` diz pro ESP se
  é pra mandar o sinal de TODOS os aparelhos (automação/"sala toda") ou só de
  um específico ("0" ou "1" - controle individual pelo app).

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

const aparelhoVazio = () => ({ ligado: false, temperatura: 22 });

// Cada sala: o que o SITE pediu (desejado) x o que o ESP confirmou (aplicado).
// seq sobe a cada pedido novo - o ESP compara com o que já aplicou por último.
const salas = new Map(); // id -> { qtd, protocolos, desejado: {aparelhos,seq,alvo}, aplicado: {aparelhos}, ... }

function getSala(id) {
  if (!salas.has(id)) {
    salas.set(id, {
      qtd: 1,
      protocolos: ['MIDEA', 'MIDEA'],
      desejado: { aparelhos: [aparelhoVazio(), aparelhoVazio()], seq: 0, alvo: 'todos' },
      aplicado: { aparelhos: [aparelhoVazio(), aparelhoVazio()] },
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

// ===================== API PRO SITE (sala toda - automação/compatibilidade) =====================
app.get('/sala/:id/estado', (req, res) => {
  const sala = getSala(req.params.id);
  const ap = sala.aplicado.aparelhos || [];
  res.json({
    id: Number(req.params.id),
    qtd: sala.qtd,
    ligado: ap[0] ? ap[0].ligado : false,
    temperatura: ap[0] ? ap[0].temperatura : 22,
    aparelhos: ap.slice(0, sala.qtd),
    online: online(sala)
  });
});

app.post('/sala/:id/ligar', (req, res) => {
  const sala = getSala(req.params.id);
  const temp = Number.isInteger(req.body.temperatura) ? req.body.temperatura : (sala.desejado.aparelhos[0]?.temperatura ?? 22);
  if (temp < 18 || temp > 24) return res.status(400).json({ erro: 'Temperatura inválida' });
  for (let i = 0; i < sala.qtd; i++) sala.desejado.aparelhos[i] = { ligado: true, temperatura: temp };
  sala.desejado.seq++;
  sala.desejado.alvo = 'todos';
  res.json({ id: Number(req.params.id), ligado: true, temperatura: temp });
});

app.post('/sala/:id/desligar', (req, res) => {
  const sala = getSala(req.params.id);
  for (let i = 0; i < sala.qtd; i++) sala.desejado.aparelhos[i] = { ...sala.desejado.aparelhos[i], ligado: false };
  sala.desejado.seq++;
  sala.desejado.alvo = 'todos';
  res.json({ id: Number(req.params.id), ligado: false, temperatura: sala.aplicado.aparelhos[0]?.temperatura ?? 22 });
});

app.post('/sala/:id/temperatura', (req, res) => {
  const sala = getSala(req.params.id);
  const temp = req.body.temperatura;
  if (!Number.isInteger(temp) || temp < 18 || temp > 24) return res.status(400).json({ erro: 'Temperatura inválida' });
  const algumLigado = sala.desejado.aparelhos.slice(0, sala.qtd).some(a => a.ligado);
  if (!algumLigado) return res.status(409).json({ erro: 'Sala desligada' });
  for (let i = 0; i < sala.qtd; i++) if (sala.desejado.aparelhos[i].ligado) sala.desejado.aparelhos[i].temperatura = temp;
  sala.desejado.seq++;
  sala.desejado.alvo = 'todos';
  res.json({ id: Number(req.params.id), ligado: true, temperatura: temp });
});

// ===================== API PRO SITE (1 aparelho específico) =====================
// :n vem do app como 1 ou 2 (o que o usuário vê); internamente é índice 0/1.
function idxAparelho(req, res, sala) {
  const idx = Number(req.params.n) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= sala.qtd) {
    res.status(400).json({ erro: 'Aparelho inexistente nessa sala' });
    return null;
  }
  return idx;
}

app.post('/sala/:id/aparelho/:n/ligar', (req, res) => {
  const sala = getSala(req.params.id);
  const idx = idxAparelho(req, res, sala);
  if (idx === null) return;
  const temp = Number.isInteger(req.body.temperatura) ? req.body.temperatura : sala.desejado.aparelhos[idx].temperatura;
  if (temp < 18 || temp > 24) return res.status(400).json({ erro: 'Temperatura inválida' });
  sala.desejado.aparelhos[idx] = { ligado: true, temperatura: temp };
  sala.desejado.seq++;
  sala.desejado.alvo = String(idx);
  res.json({ id: Number(req.params.id), aparelho: idx + 1, ligado: true, temperatura: temp });
});

app.post('/sala/:id/aparelho/:n/desligar', (req, res) => {
  const sala = getSala(req.params.id);
  const idx = idxAparelho(req, res, sala);
  if (idx === null) return;
  sala.desejado.aparelhos[idx] = { ...sala.desejado.aparelhos[idx], ligado: false };
  sala.desejado.seq++;
  sala.desejado.alvo = String(idx);
  res.json({ id: Number(req.params.id), aparelho: idx + 1, ligado: false, temperatura: sala.aplicado.aparelhos[idx]?.temperatura ?? 22 });
});

app.post('/sala/:id/aparelho/:n/temperatura', (req, res) => {
  const sala = getSala(req.params.id);
  const idx = idxAparelho(req, res, sala);
  if (idx === null) return;
  const temp = req.body.temperatura;
  if (!Number.isInteger(temp) || temp < 18 || temp > 24) return res.status(400).json({ erro: 'Temperatura inválida' });
  if (!sala.desejado.aparelhos[idx].ligado) return res.status(409).json({ erro: 'Aparelho desligado' });
  sala.desejado.aparelhos[idx].temperatura = temp;
  sala.desejado.seq++;
  sala.desejado.alvo = String(idx);
  res.json({ id: Number(req.params.id), aparelho: idx + 1, ligado: true, temperatura: temp });
});

// ===================== CONFIG (quantidade de aparelhos + marca de cada um) =====================
app.get('/sala/:id/config', (req, res) => {
  const sala = getSala(req.params.id);
  res.json({ qtd: sala.qtd, protocolos: sala.protocolos });
});

app.post('/sala/:id/config', (req, res) => {
  if (!autenticado(req)) return res.status(401).json({ erro: 'Não autenticado' });
  const sala = getSala(req.params.id);
  const qtd = Number.isInteger(req.body.qtd) ? req.body.qtd : sala.qtd;
  if (qtd < 1 || qtd > 2) return res.status(400).json({ erro: 'Quantidade inválida' });
  sala.qtd = qtd;
  if (Array.isArray(req.body.protocolos)) {
    req.body.protocolos.forEach((p, i) => { if (i < 2 && typeof p === 'string' && p) sala.protocolos[i] = p; });
  }
  res.json({ ok: true, qtd: sala.qtd, protocolos: sala.protocolos });
});

// ===================== ADMIN (login, agenda, senha) =====================
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
  res.json({
    desejado: sala.desejado,
    agendaDesejada: sala.agendaDesejada,
    configDesejada: { qtd: sala.qtd, protocolos: sala.protocolos }
  });
});

// O ESP manda isso depois de executar, confirmando o que realmente aplicou.
app.post('/dispositivo/:id/estado', (req, res) => {
  const sala = getSala(req.params.id);
  sala.ultimoContato = Date.now();
  if (req.body.aplicado) {
    sala.aplicado = req.body.aplicado;
    if (!Array.isArray(sala.aplicado.aparelhos)) sala.aplicado.aparelhos = [aparelhoVazio(), aparelhoVazio()];
  }
  if (req.body.agendaAplicada) sala.agendaAplicada = req.body.agendaAplicada;
  res.json({ ok: true });
});

app.get('/', (req, res) => {
  res.type('text/plain').send('Servidor-ponte BFT no ar.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor-ponte rodando na porta ${PORT}`));
