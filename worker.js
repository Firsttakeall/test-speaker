// Cloudflare Worker : relaie photo + question vers Gemini, puis la réponse vers Google TTS.
// Variables à définir (Settings → Variables and Secrets) :
//   secrets : GEMINI_KEY, TTS_KEY, APP_TOKEN
//   texte   : GEMINI_MODEL, ALLOWED_ORIGIN (ex. https://pseudo.github.io), TTS_LANG (fr-FR), TTS_VOICE (optionnel)

export default {
  async fetch(req, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Token',
      'Vary': 'Origin'
    };
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
      status, headers: { ...cors, 'Content-Type': 'application/json' }
    });

    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'POST') return json({ erreur: 'Méthode non autorisée' }, 405);
    if (req.headers.get('X-Token') !== env.APP_TOKEN) return json({ erreur: 'Jeton invalide' }, 401);

    let body;
    try { body = await req.json(); } catch { return json({ erreur: 'JSON invalide' }, 400); }
    const { question, image, mime } = body;
    if (!question || !image) return json({ erreur: 'Question ou image manquante' }, 400);
    if (image.length > 6_000_000) return json({ erreur: 'Image trop lourde' }, 413);

    // 1. Gemini : image + question -> texte
    const prompt =
      'Tu analyses la photo d’un document. Réponds en français, de façon brève, en texte brut ' +
      '(sans markdown, sans astérisques, sans listes à puces), uniquement à partir de ce qui est lisible sur le document. ' +
      'Cite la ligne ou la valeur lue. Si l’information est absente ou illisible, dis-le clairement. ' +
      'Question : ' + question;

    const g = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_KEY },
        body: JSON.stringify({
          contents: [{ parts: [
            { text: prompt },
            { inline_data: { mime_type: mime || 'image/jpeg', data: image } }
          ] }]
        })
      }
    );
    if (!g.ok) return json({ erreur: 'Gemini ' + g.status, detail: (await g.text()).slice(0, 300) }, 502);
    const gd = await g.json();
    const texte = (gd.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
    if (!texte) return json({ erreur: 'Réponse Gemini vide' }, 502);

    // 2. Google Cloud TTS : texte -> MP3 (base64)
    const voice = { languageCode: env.TTS_LANG || 'fr-FR' };
    if (env.TTS_VOICE) voice.name = env.TTS_VOICE; else voice.ssmlGender = 'FEMALE';

    const t = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': env.TTS_KEY },
      body: JSON.stringify({
        input: { text: texte.replace(/[*#_`]/g, '').slice(0, 4000) },
        voice,
        audioConfig: { audioEncoding: 'MP3' }
      })
    });
    if (!t.ok) return json({ texte, erreur_audio: 'TTS ' + t.status + ' ' + (await t.text()).slice(0, 200) });
    const td = await t.json();
    return json({ texte, audio: td.audioContent });
  }
};
