// Spendwise Desk — voice + text assistant. Speech uses the browser's own
// recognition (best in Chrome / Edge); typing always works as a fallback.
(function () {
  'use strict';

  const root = document.querySelector('[data-assistant]');
  if (!root) return;

  const log = root.querySelector('[data-log]');
  const form = root.querySelector('[data-form]');
  const input = root.querySelector('[data-text]');
  const sendBtn = root.querySelector('[data-send]');
  const micBtn = root.querySelector('[data-mic]');
  const micStatus = root.querySelector('[data-mic-status]');
  const previewBox = root.querySelector('[data-preview]');
  const optionsBox = root.querySelector('[data-options]');
  const speakToggle = document.getElementById('speak-toggle');

  let pending = null;
  let lastIntent = 'other';
  let channel = 'text';
  let busy = false;

  // ── Your questions (answers appear here once finance approves them) ───────
  const questionsBox = document.querySelector('[data-questions]');
  async function refreshQuestions() {
    if (!questionsBox) return;
    try {
      const res = await fetch('/assistant/questions', { headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const { questions } = await res.json();
      const list = document.createElement('ul');
      list.className = 'my-questions';
      questions.forEach((q) => {
        const li = document.createElement('li');
        const head = document.createElement('div');
        const strong = document.createElement('strong');
        strong.textContent = `“${q.question}” `;
        const badge = document.createElement('span');
        badge.className = `badge ${q.status === 'answered' ? 'status-approved' : q.status === 'declined' ? 'status-rejected' : 'flag'}`;
        badge.textContent = q.status === 'answered' ? 'answered' : q.status === 'declined' ? 'declined' : 'with finance';
        head.append(strong, badge);
        li.appendChild(head);
        if (q.reply) {
          const p = document.createElement('div');
          p.textContent = q.reply;
          li.appendChild(p);
        }
        q.sources.forEach((s) => {
          const row = document.createElement('div');
          row.className = 'small';
          const a = document.createElement('a');
          a.href = s.url;
          a.target = '_blank';
          a.rel = 'noopener';
          a.textContent = `Source: ${s.title}`;
          row.append(a, document.createTextNode(` · last checked ${s.lastChecked}`));
          li.appendChild(row);
        });
        list.appendChild(li);
      });
      const empty = document.createElement('p');
      empty.className = 'muted small';
      empty.textContent = 'No questions yet.';
      questionsBox.replaceChildren(questions.length ? list : empty);
    } catch {
      /* keep what is shown */
    }
  }
  refreshQuestions();

  // ── Rendering ──────────────────────────────────────────────────────────────
  function bubble(text, who, extraClass) {
    const div = document.createElement('div');
    div.className = `bubble bubble-${who}${extraClass ? ` ${extraClass}` : ''}`;
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
  }

  function speak(text) {
    if (!speakToggle || !speakToggle.checked || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-IN';
    window.speechSynthesis.speak(u);
  }

  function clearExtras() {
    previewBox.hidden = true;
    previewBox.replaceChildren();
    optionsBox.replaceChildren();
  }

  function renderOptions(options) {
    optionsBox.replaceChildren();
    (options || []).forEach((label) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-sm chip';
      b.textContent = label;
      b.addEventListener('click', () => send(label, 'text'));
      optionsBox.appendChild(b);
    });
  }

  function renderPolicy(policy, bubbleEl) {
    if (!policy) return;
    const box = document.createElement('div');
    box.className = 'policy-sources small';
    if (policy.queued) {
      const q = document.createElement('div');
      q.className = 'badge flag';
      q.textContent = 'Waiting for finance review';
      box.appendChild(q);
    }
    if (policy.canonical) {
      const c = document.createElement('div');
      c.className = 'badge source';
      c.textContent = `Approved answer: ${policy.canonical.title}`;
      box.appendChild(c);
    }
    if (policy.sources && policy.sources.length) {
      policy.sources.forEach((s) => {
        const a = document.createElement('a');
        a.href = s.url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = `Source: ${s.title}`;
        const when = document.createElement('span');
        when.className = 'muted';
        when.textContent = ` · last checked ${s.lastChecked}`;
        const row = document.createElement('div');
        row.append(a, when);
        box.appendChild(row);
      });
    } else if (policy.searched && policy.searched.length) {
      box.textContent = `Searched: ${policy.searched.join(', ')}`;
    }
    if (box.childNodes.length) bubbleEl.appendChild(box);
  }

  function renderPreview(preview) {
    previewBox.replaceChildren();
    const card = document.createElement('div');
    card.className = 'card highlight preview-card';

    const h = document.createElement('h2');
    h.textContent = preview.title;
    card.appendChild(h);

    const note = document.createElement('p');
    note.className = 'small muted';
    note.textContent = 'This will be written to Spendwise only when you confirm:';
    card.appendChild(note);

    const dl = document.createElement('dl');
    dl.className = 'preview-lines';
    preview.lines.forEach((l) => {
      const dt = document.createElement('dt');
      dt.textContent = l.label;
      const dd = document.createElement('dd');
      dd.textContent = l.value;
      dl.append(dt, dd);
    });
    card.appendChild(dl);

    if (preview.flags.length) {
      const flags = document.createElement('div');
      flags.className = 'preview-flags';
      preview.flags.forEach((f) => {
        const s = document.createElement('span');
        s.className = 'flag';
        s.textContent = f;
        flags.appendChild(s);
      });
      card.appendChild(flags);
    }

    const actions = document.createElement('div');
    actions.className = 'preview-actions';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'btn btn-primary';
    ok.textContent = preview.confirmLabel;
    ok.addEventListener('click', () => confirm(preview.token, ok));
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', cancelPreview);
    actions.append(ok, cancel);
    card.appendChild(actions);

    previewBox.appendChild(card);
    previewBox.hidden = false;
    ok.focus();
  }

  // ── Server calls ───────────────────────────────────────────────────────────
  async function post(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
    return data;
  }

  function setBusy(on) {
    busy = on;
    sendBtn.disabled = on;
    input.disabled = on;
  }

  async function send(text, via) {
    text = String(text || '').trim();
    if (!text || busy) return;
    clearExtras();
    bubble(text, 'user');
    input.value = '';
    setBusy(true);
    const thinking = bubble('…', 'bot', 'thinking');
    try {
      const r = await post('/assistant/message', { text, channel: via, pending });
      thinking.remove();
      pending = r.pending || null;
      lastIntent = r.intent;
      const b = bubble(
        r.reply,
        'bot',
        r.outcome === 'refused' ? 'refused' : r.outcome === 'not_covered' ? 'not-covered' : '',
      );
      if (r.redacted && r.redacted.length) {
        const n = document.createElement('div');
        n.className = 'small muted';
        n.textContent = `Removed from your message for privacy: ${r.redacted.join(', ').toLowerCase()}.`;
        b.appendChild(n);
      }
      renderPolicy(r.policy, b);
      if (r.policy && r.policy.queued) refreshQuestions();
      renderOptions(r.options);
      if (r.preview) renderPreview(r.preview);
      speak(r.reply);
    } catch (err) {
      thinking.remove();
      bubble(err.message, 'bot', 'refused');
    } finally {
      setBusy(false);
      input.focus();
    }
  }

  async function confirm(token, btn) {
    btn.disabled = true;
    try {
      const r = await post('/assistant/confirm', { token, channel });
      clearExtras();
      pending = null;
      const b = bubble(`${r.reply} `, 'bot', 'confirmed');
      const a = document.createElement('a');
      a.href = r.url;
      a.textContent = 'Open the claim';
      b.appendChild(a);
      speak(r.reply);
    } catch (err) {
      btn.disabled = false;
      bubble(err.message, 'bot', 'refused');
    }
  }

  function cancelPreview() {
    clearExtras();
    pending = null;
    bubble('Cancelled. Nothing was saved.', 'bot');
    post('/assistant/cancel', { intent: lastIntent, channel }).catch(() => {});
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    channel = 'text';
    send(input.value, 'text');
  });

  // ── Voice input ────────────────────────────────────────────────────────────
  // Preferred: record audio in the browser and transcribe it on the server with
  // Whisper (works in every modern browser, including Safari). Fallback: the
  // browser's own speech recognition (Chrome / Edge). Otherwise: type.
  const canRecord = Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  const useWhisper = root.dataset.whisper === 'true' && canRecord;
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  function setListening(on, label) {
    micBtn.classList.toggle('listening', on);
    micBtn.setAttribute('aria-label', on ? 'Stop listening' : 'Start speaking');
    if (label) micStatus.textContent = label;
  }

  function sendVoice(text) {
    text = String(text || '').trim();
    if (!text) {
      micStatus.textContent = "I didn't catch anything. Tap the mic and try again, or type.";
      return;
    }
    micStatus.textContent = 'Nothing is saved until you confirm a preview.';
    channel = 'voice';
    send(text, 'voice');
  }

  if (useWhisper) {
    const MAX_MS = 20000; // hard stop
    const SILENCE_MS = 1400; // stop after this much quiet once speech was heard
    let recorder = null;
    let stream = null;
    let chunks = [];
    let stopTimer = null;
    let audioCtx = null;

    const pickType = () =>
      ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(
        (t) => window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported(t),
      ) || '';

    function stopRecording() {
      if (recorder && recorder.state === 'recording') recorder.stop();
    }

    function watchSilence() {
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const src = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 1024;
        src.connect(analyser);
        const buf = new Uint8Array(analyser.fftSize);
        let heard = false;
        let quietSince = performance.now();
        const tick = () => {
          if (!recorder || recorder.state !== 'recording') return;
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) sum += ((buf[i] - 128) / 128) ** 2;
          const rms = Math.sqrt(sum / buf.length);
          const now = performance.now();
          if (rms > 0.04) {
            heard = true;
            quietSince = now;
          } else if (heard && now - quietSince > SILENCE_MS) {
            return stopRecording();
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      } catch {
        /* no silence detection: the user taps to stop, or the hard stop ends it */
      }
    }

    async function startRecording() {
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        micStatus.textContent = 'Microphone access was blocked. Allow it in the browser, or type instead.';
        return;
      }
      chunks = [];
      const type = pickType();
      recorder = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream);
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size) chunks.push(e.data);
      };
      recorder.onstop = async () => {
        clearTimeout(stopTimer);
        stream.getTracks().forEach((t) => t.stop());
        if (audioCtx) audioCtx.close().catch(() => {});
        setListening(false, 'Transcribing…');
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        if (blob.size < 1000) return sendVoice('');
        const form = new FormData();
        const ext = (blob.type.split('/')[1] || 'webm').split(';')[0];
        form.append('audio', blob, `voice.${ext}`);
        try {
          const res = await fetch('/assistant/transcribe', {
            method: 'POST',
            body: form,
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'Could not transcribe the audio.');
          input.value = data.text || '';
          sendVoice(data.text);
        } catch (err) {
          micStatus.textContent = `${err.message} You can type instead.`;
        }
      };
      recorder.start();
      setListening(true, 'Listening… speak now (it stops when you pause, or tap again).');
      stopTimer = setTimeout(stopRecording, MAX_MS);
      watchSilence();
    }

    micBtn.title = 'Speak (transcribed by Whisper)';
    micBtn.addEventListener('click', () => {
      if (recorder && recorder.state === 'recording') return stopRecording();
      startRecording();
    });
    return;
  }

  if (!Recognition) {
    micBtn.disabled = true;
    micBtn.title = 'Voice input needs Chrome or Edge';
    micStatus.textContent = 'Voice input is not supported in this browser (try Chrome or Edge). You can type instead.';
    return;
  }

  const rec = new Recognition();
  rec.lang = 'en-IN';
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  let listening = false;
  let finalText = '';

  rec.onstart = () => {
    listening = true;
    finalText = '';
    setListening(true, 'Listening… speak now.');
  };
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalText += t;
      else interim += t;
    }
    input.value = (finalText + interim).trim();
  };
  rec.onerror = (e) => {
    micStatus.textContent =
      e.error === 'not-allowed'
        ? 'Microphone access was blocked. Allow it in the browser, or type instead.'
        : e.error === 'no-speech'
          ? "I didn't hear anything. Tap the mic and try again."
          : 'Voice input stopped. You can try again or type.';
  };
  rec.onend = () => {
    listening = false;
    setListening(false);
    const text = (finalText || input.value).trim();
    if (text) sendVoice(text);
  };

  micBtn.addEventListener('click', () => {
    if (listening) return rec.stop();
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    try {
      rec.start();
    } catch {
      /* already started */
    }
  });
})();
