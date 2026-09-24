// Base di conoscenza del voicebot: unica fonte di informazioni per Claude.
const fs = require('node:fs');
const path = require('node:path');

const KNOWLEDGE_FILE = path.join(__dirname, '..', 'knowledge', 'nazareth.md');

// Letta una sola volta all'avvio: se il file manca il server non parte.
const knowledgeBase = fs.readFileSync(KNOWLEDGE_FILE, 'utf8');

module.exports = { knowledgeBase, KNOWLEDGE_FILE };
