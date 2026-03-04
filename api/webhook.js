const { createClient } = require('@supabase/supabase-js');
const {
  calculerDalle, calculerCloture, calculerMaison,
  formatApercuMessenger, formatDevisCompletMessenger,
  PRIX_DEFAUT
} = require('../lib/calcul');

const VERIFY_TOKEN = process.env.MESSENGER_VERIFY_TOKEN || 'tranoko_verify_2024';
const PAGE_TOKEN   = process.env.MESSENGER_PAGE_TOKEN;
const ADMIN_PSID   = process.env.ADMIN_PSID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

const supabase = SUPABASE_URL ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    const mode      = req.query['hub.mode'];
    const token     = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Token invalide');
  }

  if (req.method === 'POST') {
    const body = req.body;
    if (body.object !== 'page') return res.sendStatus(404);
    for (const entry of body.entry || []) {
      for (const event of entry.messaging || []) {
        await traiterEvenement(event);
      }
    }
    return res.sendStatus(200);
  }

  return res.sendStatus(405);
};

async function traiterEvenement(event) {
  const psid = event.sender && event.sender.id;
  if (!psid) return;

  if (event.message && event.message.text) {
    const texte = event.message.text.trim();
    if (psid === ADMIN_PSID) {
      await traiterReponseAdmin(psid, texte);
    } else {
      await traiterMessageClient(psid, texte);
    }
    return;
  }

  if (event.message && event.message.attachments) {
    const att = event.message.attachments[0];
    if (att.type === 'image') {
      await traiterCapturePayment(psid, att.payload.url);
    }
    return;
  }

  if (event.message && event.message.quick_reply) {
    await traiterMessageClient(psid, event.message.quick_reply.payload);
    return;
  }

  if (event.postback) {
    await traiterMessageClient(psid, event.postback.payload);
  }
}

async function traiterMessageClient(psid, texte) {
  const session = await getSession(psid);
  const msg = texte.toLowerCase().trim();

  const motsMenu = ['menu', 'bonjour', 'salut', 'hello', 'start', 'debut', 'recommencer'];
  if (motsMenu.some(function(m) { return msg.includes(m); })) {
    await resetSession(psid);
    await envoyerMenu(psid);
    return;
  }

  if (!session || !session.etape) {
    if (msg.includes('dalle') || msg.includes('plancher') || msg.includes('beton')) {
      await setSession(psid, { type: 'dalle', etape: 'lon' });
      await envoyer(psid, 'Devis Dalle Beton\n\nQuelle est la longueur de votre dalle ?\n(en metres, ex: 5 ou 6.5)');
    } else if (msg.includes('maison') || msg.includes('villa') || msg.includes('habitation')) {
      await setSession(psid, { type: 'maison', etape: 'surf' });
      await envoyer(psid, 'Devis Maison Complete\n\nQuelle est la surface totale du RDC ?\n(en m2, ex: 80)');
    } else if (msg.includes('clot') || msg.includes('mur') || msg.includes('portail')) {
      await setSession(psid, { type: 'cloture', etape: 'lon' });
      await envoyer(psid, 'Devis Cloture\n\nQuelle est la longueur totale de votre cloture ?\n(en metres, ex: 30)');
    } else {
      await envoyerMenu(psid);
    }
    return;
  }

  if (session.type === 'dalle') {
    await conversDalle(psid, session, texte);
  } else if (session.type === 'maison') {
    await conversMaison(psid, session, texte);
  } else if (session.type === 'cloture') {
    await conversCloture(psid, session, texte);
  } else if (session.type === 'attente_paiement') {
    await envoyer(psid, 'Votre devis est en attente.\n\nSi vous avez deja paye, envoyez la capture de votre recu MVola.\nMVola : 034 257 91 82');
  }
}

async function conversDalle(psid, session, texte) {
  const params = session.params || {};
  const nb = parseFloat(texte.replace(',', '.'));

  if (session.etape === 'lon') {
    if (isNaN(nb) || nb <= 0) { await envoyer(psid, 'Entrez un nombre valide (ex: 6)'); return; }
    params.lon = nb;
    await setSession(psid, { type: 'dalle', etape: 'lar', params: params });
    await envoyer(psid, 'Largeur de la dalle ? (en metres, ex: 4)');

  } else if (session.etape === 'lar') {
    if (isNaN(nb) || nb <= 0) { await envoyer(psid, 'Entrez un nombre valide (ex: 4)'); return; }
    params.lar = nb;
    await setSession(psid, { type: 'dalle', etape: 'niveau', params: params });
    await envoyerChoix(psid, 'Quel est le niveau ?', [
      { title: 'RDC', payload: 'rdc' },
      { title: 'Etage', payload: 'etage' },
      { title: 'Terrasse', payload: 'terrasse' }
    ]);

  } else if (session.etape === 'niveau') {
    const niveaux = { rdc: 'rdc', etage: 'etage', terrasse: 'terrasse' };
    const niv = niveaux[texte.toLowerCase()];
    if (!niv) { await envoyer(psid, 'Repondez : RDC, Etage ou Terrasse'); return; }
    params.niveau = niv;
    await setSession(psid, { type: 'dalle', etape: 'ep', params: params });
    await envoyerChoix(psid, 'Epaisseur ?', [
      { title: '10 cm', payload: '10' },
      { title: '15 cm', payload: '15' },
      { title: '20 cm', payload: '20' }
    ]);

  } else if (session.etape === 'ep') {
    params.ep = parseInt(texte) || 15;
    await setSession(psid, { type: 'dalle', etape: 'region', params: params });
    await envoyerChoix(psid, 'Region ?', [
      { title: 'Antananarivo', payload: 'tana' },
      { title: 'Autres', payload: 'autres' }
    ]);

  } else if (session.etape === 'region') {
    params.region = texte === 'autres' ? 'autres' : 'tana';
    await envoyer(psid, 'Calcul en cours...');
    const prix = await getPrix();
    const result = calculerDalle(params, prix);
    const apercu = formatApercuMessenger('dalle', result);
    await setSession(psid, { type: 'attente_paiement', etape: 'paiement', devisType: 'dalle', params: params, resultSnapshot: JSON.stringify(result) });
    await envoyer(psid, apercu);
  }
}

async function conversCloture(psid, session, texte) {
  const params = session.params || {};
  const nb = parseFloat(texte.replace(',', '.'));

  if (session.etape === 'lon') {
    if (isNaN(nb) || nb <= 0) { await envoyer(psid, 'Longueur en m (ex: 30)'); return; }
    params.lon = nb;
    await setSession(psid, { type: 'cloture', etape: 'haut', params: params });
    await envoyerChoix(psid, 'Hauteur ?', [
      { title: '1m', payload: '1' },
      { title: '1.5m', payload: '1.5' },
      { title: '2m', payload: '2' }
    ]);

  } else if (session.etape === 'haut') {
    params.haut = parseFloat(texte) || 1.5;
    await setSession(psid, { type: 'cloture', etape: 'type', params: params });
    await envoyerChoix(psid, 'Type ?', [
      { title: 'Parpaing', payload: 'parpaing' },
      { title: 'Pierre', payload: 'pierre' },
      { title: 'Portail', payload: 'portail' }
    ]);

  } else if (session.etape === 'type') {
    params.type = texte.toLowerCase() || 'parpaing';
    await setSession(psid, { type: 'cloture', etape: 'region', params: params });
    await envoyerChoix(psid, 'Region ?', [
      { title: 'Tana', payload: 'tana' },
      { title: 'Autres', payload: 'autres' }
    ]);

  } else if (session.etape === 'region') {
    params.region = texte === 'autres' ? 'autres' : 'tana';
    await envoyer(psid, 'Calcul en cours...');
    const prix = await getPrix();
    const result = calculerCloture(params, prix);
    const apercu = formatApercuMessenger('cloture', result);
    await setSession(psid, { type: 'attente_paiement', etape: 'paiement', devisType: 'cloture', params: params, resultSnapshot: JSON.stringify(result) });
    await envoyer(psid, apercu);
  }
}

async function conversMaison(psid, session, texte) {
  const params = session.params || {};
  const nb = parseFloat(texte.replace(',', '.'));

  if (session.etape === 'surf') {
    if (isNaN(nb) || nb <= 0) { await envoyer(psid, 'Surface en m2 (ex: 80)'); return; }
    params.surf = nb;
    await setSession(psid, { type: 'maison', etape: 'niv', params: params });
    await envoyerChoix(psid, 'Etages ?', [
      { title: 'RDC', payload: '0' },
      { title: 'RDC + 1', payload: '1' },
      { title: 'RDC + 2', payload: '2' }
    ]);

  } else if (session.etape === 'niv') {
    params.niv = parseInt(texte) || 0;
    await setSession(psid, { type: 'maison', etape: 'region', params: params });
    await envoyerChoix(psid, 'Region ?', [
      { title: 'Tana', payload: 'tana' },
      { title: 'Autres', payload: 'autres' }
    ]);

  } else if (session.etape === 'region') {
    params.region = texte === 'autres' ? 'autres' : 'tana';
    await envoyer(psid, 'Calcul en cours...');
    const prix = await getPrix();
    const result = calculerMaison(params, prix);
    const apercu = formatApercuMessenger('maison', result);
    await setSession(psid, { type: 'attente_paiement', etape: 'paiement', devisType: 'maison', params: params, resultSnapshot: JSON.stringify(result) });
    await envoyer(psid, apercu);
  }
}

async function traiterCapturePayment(psid, imageUrl) {
  const session = await getSession(psid);
  if (!session || session.type !== 'attente_paiement') {
    await envoyer(psid, 'Aucun devis en attente.');
    return;
  }
  const payId = 'PAY-' + Date.now() + '-' + psid.slice(-4);
  if (supabase) {
    await supabase.from('paiements_en_attente').insert({
      id: payId, psid: psid,
      devis_type: session.devisType,
      params: session.params,
      result_snapshot: session.resultSnapshot,
      image_url: imageUrl,
      statut: 'en_attente',
      created_at: new Date().toISOString()
    });
  }
  await setSession(psid, Object.assign({}, session, { payId: payId, statut: 'capture_envoyee' }));
  if (ADMIN_PSID) {
    await envoyer(ADMIN_PSID, 'PAIEMENT\nType : ' + (session.devisType || '').toUpperCase() + '\nID : ' + payId + '\n\nRepondez: ok ' + payId);
    await envoyerImage(ADMIN_PSID, imageUrl);
  }
  await envoyer(psid, 'Recu ! Verification en cours...');
}

async function traiterReponseAdmin(adminPsid, texte) {
  const msg = texte.toLowerCase().trim();
  if (msg.startsWith('ok ')) {
    const payId = texte.split(' ')[1];
    await validerPaiement(payId);
  } else if (msg.startsWith('refus ')) {
    const payId = texte.split(' ')[1];
    await refuserPaiement(payId);
  } else {
    await envoyer(adminPsid, 'Commandes : "ok PAY-XXXX" ou "refus PAY-XXXX"');
  }
}

async function validerPaiement(payId) {
  if (!supabase) return;
  const res = await supabase.from('paiements_en_attente').select('*').eq('id', payId).single();
  const data = res.data;
  if (!data) { await envoyer(ADMIN_PSID, 'Paiement ' + payId + ' introuvable'); return; }
  const code = await genererCode(data.devis_type);
  await supabase.from('paiements_en_attente').update({ statut: 'valide', code: code }).eq('id', payId);
  await supabase.from('codes_acces').insert({ code: code, type: data.devis_type, psid: data.psid, pay_id: payId, used: false });
  const result = JSON.parse(data.result_snapshot);
  const devisComplet = formatDevisCompletMessenger(data.devis_type, result);
  await envoyer(data.psid, devisComplet);
  await envoyer(data.psid, 'Code : ' + code);
  await envoyer(ADMIN_PSID, 'Paiement ' + payId + ' valide.');
}

async function refuserPaiement(payId) {
  if (!supabase) return;
  const res = await supabase.from('paiements_en_attente').select('psid').eq('id', payId).single();
  if (!res.data) return;
  await supabase.from('paiements_en_attente').update({ statut: 'refuse' }).eq('id', payId);
  await envoyer(res.data.psid, 'Paiement refuse. Contactez-nous.');
}

async function genererCode(type) {
  const prefixes = { dalle: 'DALL', maison: 'MAIS', cloture: 'CLOT' };
  const prefix = prefixes[type] || 'CODE';
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let nonce = '';
  for (let i = 0; i < 6; i++) {
    nonce += chars[Math.floor(Math.random() * chars.length)];
  }
  return prefix + '-' + nonce;
}

const sessionMemoire = {};

async function getSession(psid) {
  if (supabase) {
    const res = await supabase.from('sessions_bot').select('data').eq('psid', psid).single();
    return res.data ? res.data.data : null;
  }
  return sessionMemoire[psid] || null;
}

async function setSession(psid, data) {
  if (supabase) {
    await supabase.from('sessions_bot').upsert({ psid: psid, data: data, updated_at: new Date().toISOString() });
  } else {
    sessionMemoire[psid] = data;
  }
}

async function resetSession(psid) {
  if (supabase) {
    await supabase.from('sessions_bot').delete().eq('psid', psid);
  } else {
    delete sessionMemoire[psid];
  }
}

async function getPrix() {
  if (!supabase) return PRIX_DEFAUT;
  const res = await supabase.from('prix').select('cle, valeur');
  if (!res.data || res.data.length === 0) return PRIX_DEFAUT;
  const prix = Object.assign({}, PRIX_DEFAUT);
  res.data.forEach(function(row) { prix[row.cle] = row.valeur; });
  return prix;
}

async function envoyer(psid, texte) {
  if (!PAGE_TOKEN) { console.log('[BOT] ' + psid + ': ' + texte); return; }
  await fetch('https://graph.facebook.com/v19.0/me/messages?access_token=' + PAGE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: psid }, message: { text: texte } })
  });
}

async function envoyerImage(psid, imageUrl) {
  if (!PAGE_TOKEN) return;
  await fetch('https://graph.facebook.com/v19.0/me/messages?access_token=' + PAGE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: psid }, message: { attachment: { type: 'image', payload: { url: imageUrl, is_reusable: true } } } })
  });
}

async function envoyerChoix(psid, texte, boutons) {
  if (!PAGE_TOKEN) { console.log('[BOT] ' + psid + ': ' + texte); return; }
  const quickReplies = boutons.map(function(b) { return { content_type: 'text', title: b.title, payload: b.payload }; });
  await fetch('https://graph.facebook.com/v19.0/me/messages?access_token=' + PAGE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: psid }, message: { text: texte, quick_replies: quickReplies } })
  });
}

async function envoyerMenu(psid) {
  await envoyer(psid, 'Bienvenue chez TRANOKO !\nDevis BTP Madagascar\n\nQue voulez-vous estimer ?');
  await envoyerChoix(psid, 'Choisissez :', [
    { title: 'Dalle Beton', payload: 'dalle' },
    { title: 'Maison', payload: 'maison' },
    { title: 'Cloture', payload: 'cloture' }
  ]);
  }
