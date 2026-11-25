(function receiverCapabilityGate(global) {
  "use strict";

  const RECEIVER_VERSION = "2.0.0";
  const RECEIVER_REVISION = "connected-state-idle-return-20261103-01";
  // After this many ms with no active cast (sitting on "Casting Stopped" or
  // "Connection Lost"), release the Cast session so the TV returns to its
  // own home screen instead of sitting on an idle Screen Mirror page
  // indefinitely. Does not apply to "Ready to Cast" (first launch, still
  // mid-setup) or "Reconnecting" (an in-progress recovery) — only after a
  // cast has actually stopped or dropped.
  const IDLE_RETURN_TO_HOME_MS = 90000;
  const PROTOCOL_VERSION = 2;
  const NAMESPACE = "urn:x-cast:com.ashwinbhajan.screenmirror.cmafprobe.v2";
  const MIME_TYPE = 'video/mp4; codecs="avc1.42e01f"';
  const AUDIO_MIME_TYPE = 'audio/mp4; codecs="mp4a.40.2"';
  const MAX_MESSAGE_BYTES = 1024;
  const RETAINED_HISTORY_SECONDS = 2.5;
  const TRIM_HISTORY_THRESHOLD_SECONDS = 4;
  const LIVE_EDGE_FAST_THRESHOLD_SECONDS = 1.25;
  const LIVE_EDGE_NORMAL_THRESHOLD_SECONDS = 0.75;
  const LIVE_EDGE_FAST_PLAYBACK_RATE = 1.2;
  const HEALTHY_CATCHUP_TRIGGER_SECONDS = 6;
  const HEALTHY_CATCHUP_REARM_SECONDS = 3;
  const HEALTHY_CATCHUP_MARGIN_SECONDS = 1;
  const HEALTHY_CATCHUP_MIN_JUMP_SECONDS = 2;
  const HEALTHY_CATCHUP_PERSIST_MS = 2500;
  const HEALTHY_CATCHUP_COOLDOWN_MS = 10000;
  const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;
  const RESULT = Object.freeze({
    PASS: "capability_pass",
    PARTIAL: "capability_partial",
    FAILED: "capability_failed",
    MIXED_CONTENT_BLOCKED: "websocket_mixed_content_blocked",
    WEBSOCKET_FAILED: "websocket_failed"
  });

  const startupTiming = Object.create(null);
  const senderConnections = new Map();
  let activeReceiverPagehideListener = null;
  let activeMediaRun = 0;
  const receiverNow = () => global.performance && typeof global.performance.now === "function" ? global.performance.now() : null;
  startupTiming.receiver_page_script_started = Number.isFinite(global.__screenMirrorPageScriptStarted)
    ? global.__screenMirrorPageScriptStarted : receiverNow();
  function recordReceiverStartup(name, at = receiverNow()) {
    if (Number.isFinite(at) && startupTiming[name] === undefined) startupTiming[name] = at;
  }
  function emitReceiverStartup(event, request) {
    for (const name of ["receiver_page_script_started", "receiver_caf_context_ready", "receiver_namespace_registered"]) {
      if (Number.isFinite(startupTiming[name])) {
        try { sendMediaResult(event.senderId, request.requestId, name, undefined, startupTiming[name]); } catch (_) {}
      }
    }
    const connectedAt = senderConnections.get(event.senderId);
    if (Number.isFinite(connectedAt)) {
      try { sendMediaResult(event.senderId, request.requestId, "receiver_sender_connected", undefined, connectedAt); } catch (_) {}
    }
  }

  let context;
  let ui;
  // "lost" means the TV is showing "Connection Lost / Waiting for iPhone" — it IS ready for a
  // new sender to reconnect. Only "playing" (someone actively mirroring) blocks a new session.
  const receiverReadinessStateForScreen = (screen) => screen === "playing" ? "mirroring" : "ready";
  let receiverReadinessState = "ready";
  let capabilities = Object.freeze({ webSocketAPI: false, mediaSource: false, avcMIME: false, sourceBuffer: false, autoplay: "deferred", websocketAttempted: false, websocketAuthenticated: false, probeAckStatus: "not_attempted", terminalStatus: "capability_partial", websocketLifecycle: "not_attempted" });
  let capabilityProbe = Object.freeze({ avcMIMEOutcome: "not_tested", avcMIMEException: "none", sourceBufferOutcome: "not_tested", sourceBufferException: "none" });
  const capabilityProbeTrace = { settled: "not_started", sourceOpen: "not_seen", addSourceBuffer: "not_attempted", sourceStateAtTimeout: "na", source: null, sourceOpenDelayMs: -1 };
  let capabilityReadyPromise = Promise.resolve(capabilities);

  function byteLength(value) { return new TextEncoder().encode(value).length; }
  function safeObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
  const SCREEN_COPY = Object.freeze({
    // Titles "Ready to Cast", "Casting Stopped" and "Connection Lost" are part of the
    // Start/Stop acceptance contract (AGENTS.md) and stay exactly as they are.
    ready: Object.freeze(["Ready to Cast", "On your iPhone, open Screen Mirror and tap Cast to TV."]),
    connected: Object.freeze(["Connected", "Starting your cast…"]),
    stopped: Object.freeze(["Casting Stopped", "Tap Cast to TV on your iPhone to start again."]),
    lost: Object.freeze(["Connection Lost", "Check that your iPhone and TV are on the same Wi‑Fi, then tap Cast to TV again."]),
    reconnecting: Object.freeze(["Reconnecting…", "Keep Screen Mirror open on your iPhone."]),
    // Phone connected but never started: do not leave "Starting your cast…" up.
    waitingForStart: Object.freeze(["Ready to Cast", "Your iPhone is connected. Tap Start Casting in the app."]),
    // Picture stuck long after a stall: never sit on "Reconnecting" forever.
    // Media connection still open but no new picture for 30 s — most often the
    // iPhone was locked or its screen went off. Not a lost connection, so the TV
    // keeps waiting (a real loss closes the connection and shows "Connection Lost").
    stalledLost: Object.freeze(["Waiting for Your iPhone", "Check that your iPhone is on and on the same Wi‑Fi as this TV. If it doesn’t come back, tap Cast to TV again."]),
    // The TV never reached the iPhone (first picture never arrived): almost always
    // a network that keeps devices apart (guest/office Wi‑Fi, VPN, different band).
    unreachable: Object.freeze(["Can’t Reach Your iPhone", "Your iPhone and TV need to be on the same Wi‑Fi. Guest and office networks often block this."]),
    // A photo, video or video link sent from the iPhone could not be played here.
    mediaError: Object.freeze(["Can’t Play This", "This photo or video can’t be shown on this TV. Try another one on your iPhone."])
  });
  // TV screens in the TV's language (P6). English stays word-for-word the
  // acceptance copy above. App button names stay in English (in quotes) so they
  // match what the person sees in the iPhone app, which is English-only.
  const SCREEN_EXTRA_COPY_EN = Object.freeze({"steps": ["Connect your iPhone to the same Wi‑Fi as this TV", "Open Screen Mirror on your iPhone", "Tap Cast to TV"], "chip": "iPhone connected", "badgeStall": "Reconnecting…", "badgePaused": "Paused on your iPhone"});
  const SCREEN_TRANSLATIONS = Object.freeze({
    es: {"ready": ["Listo para transmitir", "En tu iPhone, abre Screen Mirror y toca «Cast to TV»."], "connected": ["Conectado", "Iniciando la transmisión…"], "stopped": ["Transmisión detenida", "Toca «Cast to TV» en tu iPhone para empezar de nuevo."], "lost": ["Conexión perdida", "Comprueba que tu iPhone y la TV estén en la misma red Wi‑Fi y vuelve a tocar «Cast to TV»."], "reconnecting": ["Reconectando…", "Mantén Screen Mirror abierta en tu iPhone."], "waitingForStart": ["Listo para transmitir", "Tu iPhone está conectado. Toca «Start Casting» en la app."], "stalledLost": ["Esperando a tu iPhone", "Comprueba que tu iPhone esté encendido y en la misma red Wi‑Fi que esta TV. Si no vuelve, toca «Cast to TV» de nuevo."], "unreachable": ["No se puede conectar con tu iPhone", "Tu iPhone y la TV deben estar en la misma red Wi‑Fi. Las redes de invitados y de oficina suelen bloquearlo."], "steps": ["Conecta tu iPhone a la misma red Wi‑Fi que esta TV", "Abre Screen Mirror en tu iPhone", "Toca «Cast to TV»"], "chip": "iPhone conectado", "badgeStall": "Reconectando…", "badgePaused": "En pausa en tu iPhone", "mediaError": ["No se puede reproducir", "Esta foto o este video no se pueden mostrar en esta TV. Prueba con otro en tu iPhone."]},
    pt: {"ready": ["Pronto para transmitir", "No seu iPhone, abra o Screen Mirror e toque em “Cast to TV”."], "connected": ["Conectado", "Iniciando a transmissão…"], "stopped": ["Transmissão encerrada", "Toque em “Cast to TV” no seu iPhone para começar de novo."], "lost": ["Conexão perdida", "Verifique se o iPhone e a TV estão na mesma rede Wi‑Fi e toque em “Cast to TV” novamente."], "reconnecting": ["Reconectando…", "Mantenha o Screen Mirror aberto no seu iPhone."], "waitingForStart": ["Pronto para transmitir", "Seu iPhone está conectado. Toque em “Start Casting” no app."], "stalledLost": ["Aguardando seu iPhone", "Verifique se o iPhone está ligado e na mesma rede Wi‑Fi desta TV. Se não voltar, toque em “Cast to TV” novamente."], "unreachable": ["Não foi possível acessar seu iPhone", "O iPhone e a TV precisam estar na mesma rede Wi‑Fi. Redes de convidados e de escritório costumam bloquear isso."], "steps": ["Conecte o iPhone à mesma rede Wi‑Fi desta TV", "Abra o Screen Mirror no iPhone", "Toque em “Cast to TV”"], "chip": "iPhone conectado", "badgeStall": "Reconectando…", "badgePaused": "Pausado no seu iPhone", "mediaError": ["Não é possível reproduzir", "Esta foto ou vídeo não pode ser exibido nesta TV. Tente outro no seu iPhone."]},
    fr: {"ready": ["Prêt à diffuser", "Sur votre iPhone, ouvrez Screen Mirror et touchez « Cast to TV »."], "connected": ["Connecté", "Lancement de la diffusion…"], "stopped": ["Diffusion arrêtée", "Touchez « Cast to TV » sur votre iPhone pour recommencer."], "lost": ["Connexion perdue", "Vérifiez que votre iPhone et le téléviseur sont sur le même Wi‑Fi, puis touchez à nouveau « Cast to TV »."], "reconnecting": ["Reconnexion…", "Gardez Screen Mirror ouvert sur votre iPhone."], "waitingForStart": ["Prêt à diffuser", "Votre iPhone est connecté. Touchez « Start Casting » dans l’app."], "stalledLost": ["En attente de votre iPhone", "Vérifiez que votre iPhone est allumé et sur le même Wi‑Fi que ce téléviseur. Si rien ne revient, touchez à nouveau « Cast to TV »."], "unreachable": ["Impossible de joindre votre iPhone", "Votre iPhone et le téléviseur doivent être sur le même Wi‑Fi. Les réseaux invités et professionnels bloquent souvent cela."], "steps": ["Connectez votre iPhone au même Wi‑Fi que ce téléviseur", "Ouvrez Screen Mirror sur votre iPhone", "Touchez « Cast to TV »"], "chip": "iPhone connecté", "badgeStall": "Reconnexion…", "badgePaused": "En pause sur votre iPhone", "mediaError": ["Lecture impossible", "Cette photo ou vidéo ne peut pas être affichée sur ce téléviseur. Essayez-en une autre sur votre iPhone."]},
    de: {"ready": ["Bereit zum Streamen", "Öffne auf deinem iPhone Screen Mirror und tippe auf „Cast to TV“."], "connected": ["Verbunden", "Übertragung wird gestartet…"], "stopped": ["Übertragung beendet", "Tippe auf deinem iPhone auf „Cast to TV“, um neu zu starten."], "lost": ["Verbindung verloren", "Prüfe, ob iPhone und Fernseher im selben WLAN sind, und tippe dann erneut auf „Cast to TV“."], "reconnecting": ["Verbinde neu…", "Lass Screen Mirror auf deinem iPhone geöffnet."], "waitingForStart": ["Bereit zum Streamen", "Dein iPhone ist verbunden. Tippe in der App auf „Start Casting“."], "stalledLost": ["Warte auf dein iPhone", "Prüfe, ob dein iPhone eingeschaltet und im selben WLAN wie dieser Fernseher ist. Falls nichts passiert, tippe erneut auf „Cast to TV“."], "unreachable": ["iPhone nicht erreichbar", "iPhone und Fernseher müssen im selben WLAN sein. Gäste- und Firmennetzwerke blockieren das oft."], "steps": ["Verbinde dein iPhone mit demselben WLAN wie diesen Fernseher", "Öffne Screen Mirror auf deinem iPhone", "Tippe auf „Cast to TV“"], "chip": "iPhone verbunden", "badgeStall": "Verbinde neu…", "badgePaused": "Auf deinem iPhone pausiert", "mediaError": ["Wiedergabe nicht möglich", "Dieses Foto oder Video kann auf diesem Fernseher nicht angezeigt werden. Versuche ein anderes auf deinem iPhone."]},
    it: {"ready": ["Pronto per trasmettere", "Sul tuo iPhone, apri Screen Mirror e tocca “Cast to TV”."], "connected": ["Connesso", "Avvio della trasmissione…"], "stopped": ["Trasmissione interrotta", "Tocca “Cast to TV” sul tuo iPhone per ricominciare."], "lost": ["Connessione persa", "Verifica che iPhone e TV siano sulla stessa rete Wi‑Fi, poi tocca di nuovo “Cast to TV”."], "reconnecting": ["Riconnessione…", "Tieni Screen Mirror aperta sul tuo iPhone."], "waitingForStart": ["Pronto per trasmettere", "Il tuo iPhone è connesso. Tocca “Start Casting” nell’app."], "stalledLost": ["In attesa del tuo iPhone", "Verifica che l’iPhone sia acceso e sulla stessa rete Wi‑Fi di questa TV. Se non riprende, tocca di nuovo “Cast to TV”."], "unreachable": ["Impossibile raggiungere l’iPhone", "iPhone e TV devono essere sulla stessa rete Wi‑Fi. Le reti ospiti e aziendali spesso lo bloccano."], "steps": ["Collega l’iPhone alla stessa rete Wi‑Fi di questa TV", "Apri Screen Mirror sull’iPhone", "Tocca “Cast to TV”"], "chip": "iPhone connesso", "badgeStall": "Riconnessione…", "badgePaused": "In pausa sull’iPhone", "mediaError": ["Impossibile riprodurre", "Questa foto o questo video non può essere mostrato su questa TV. Provane un altro sull’iPhone."]},
    nl: {"ready": ["Klaar om te casten", "Open Screen Mirror op je iPhone en tik op ‘Cast to TV’."], "connected": ["Verbonden", "Je cast wordt gestart…"], "stopped": ["Casten gestopt", "Tik op je iPhone op ‘Cast to TV’ om opnieuw te beginnen."], "lost": ["Verbinding verbroken", "Controleer of je iPhone en tv op hetzelfde wifi-netwerk zitten en tik opnieuw op ‘Cast to TV’."], "reconnecting": ["Opnieuw verbinden…", "Houd Screen Mirror open op je iPhone."], "waitingForStart": ["Klaar om te casten", "Je iPhone is verbonden. Tik in de app op ‘Start Casting’."], "stalledLost": ["Wachten op je iPhone", "Controleer of je iPhone aanstaat en op hetzelfde wifi-netwerk zit als deze tv. Komt het beeld niet terug, tik dan opnieuw op ‘Cast to TV’."], "unreachable": ["Kan je iPhone niet bereiken", "Je iPhone en tv moeten op hetzelfde wifi-netwerk zitten. Gast- en kantoornetwerken blokkeren dit vaak."], "steps": ["Verbind je iPhone met hetzelfde wifi-netwerk als deze tv", "Open Screen Mirror op je iPhone", "Tik op ‘Cast to TV’"], "chip": "iPhone verbonden", "badgeStall": "Opnieuw verbinden…", "badgePaused": "Gepauzeerd op je iPhone", "mediaError": ["Kan dit niet afspelen", "Deze foto of video kan niet op deze tv worden getoond. Probeer een andere op je iPhone."]},
    id: {"ready": ["Siap untuk Cast", "Di iPhone Anda, buka Screen Mirror lalu ketuk “Cast to TV”."], "connected": ["Terhubung", "Memulai cast…"], "stopped": ["Cast Dihentikan", "Ketuk “Cast to TV” di iPhone Anda untuk memulai lagi."], "lost": ["Koneksi Terputus", "Pastikan iPhone dan TV terhubung ke Wi‑Fi yang sama, lalu ketuk “Cast to TV” lagi."], "reconnecting": ["Menghubungkan ulang…", "Biarkan Screen Mirror tetap terbuka di iPhone Anda."], "waitingForStart": ["Siap untuk Cast", "iPhone Anda sudah terhubung. Ketuk “Start Casting” di aplikasi."], "stalledLost": ["Menunggu iPhone Anda", "Pastikan iPhone menyala dan terhubung ke Wi‑Fi yang sama dengan TV ini. Jika tidak kembali, ketuk “Cast to TV” lagi."], "unreachable": ["Tidak Dapat Menjangkau iPhone Anda", "iPhone dan TV harus terhubung ke Wi‑Fi yang sama. Jaringan tamu dan kantor sering memblokir ini."], "steps": ["Hubungkan iPhone ke Wi‑Fi yang sama dengan TV ini", "Buka Screen Mirror di iPhone", "Ketuk “Cast to TV”"], "chip": "iPhone terhubung", "badgeStall": "Menghubungkan ulang…", "badgePaused": "Dijeda di iPhone Anda", "mediaError": ["Tidak Dapat Diputar", "Foto atau video ini tidak dapat ditampilkan di TV ini. Coba yang lain di iPhone Anda."]},
    tr: {"ready": ["Yayına Hazır", "iPhone’unuzda Screen Mirror’ı açın ve “Cast to TV”ye dokunun."], "connected": ["Bağlandı", "Yayın başlatılıyor…"], "stopped": ["Yayın Durduruldu", "Yeniden başlatmak için iPhone’unuzda “Cast to TV”ye dokunun."], "lost": ["Bağlantı Kesildi", "iPhone’unuzun ve TV’nin aynı Wi‑Fi ağında olduğundan emin olun, ardından tekrar “Cast to TV”ye dokunun."], "reconnecting": ["Yeniden bağlanılıyor…", "Screen Mirror’ı iPhone’unuzda açık tutun."], "waitingForStart": ["Yayına Hazır", "iPhone’unuz bağlı. Uygulamada “Start Casting”e dokunun."], "stalledLost": ["iPhone’unuz Bekleniyor", "iPhone’unuzun açık olduğundan ve bu TV ile aynı Wi‑Fi ağında olduğundan emin olun. Geri gelmezse tekrar “Cast to TV”ye dokunun."], "unreachable": ["iPhone’unuza Ulaşılamıyor", "iPhone’unuz ve TV aynı Wi‑Fi ağında olmalıdır. Misafir ve ofis ağları bunu sıklıkla engeller."], "steps": ["iPhone’unuzu bu TV ile aynı Wi‑Fi ağına bağlayın", "iPhone’unuzda Screen Mirror’ı açın", "“Cast to TV”ye dokunun"], "chip": "iPhone bağlı", "badgeStall": "Yeniden bağlanılıyor…", "badgePaused": "iPhone’unuzda duraklatıldı", "mediaError": ["Oynatılamıyor", "Bu fotoğraf veya video bu TV’de gösterilemiyor. iPhone’unuzda başka birini deneyin."]},
    pl: {"ready": ["Gotowe do przesyłania", "Na iPhonie otwórz Screen Mirror i stuknij „Cast to TV”."], "connected": ["Połączono", "Rozpoczynanie przesyłania…"], "stopped": ["Przesyłanie zatrzymane", "Stuknij „Cast to TV” na iPhonie, aby zacząć ponownie."], "lost": ["Utracono połączenie", "Sprawdź, czy iPhone i telewizor są w tej samej sieci Wi‑Fi, a potem ponownie stuknij „Cast to TV”."], "reconnecting": ["Ponowne łączenie…", "Nie zamykaj Screen Mirror na iPhonie."], "waitingForStart": ["Gotowe do przesyłania", "iPhone jest połączony. Stuknij „Start Casting” w aplikacji."], "stalledLost": ["Czekam na iPhone’a", "Sprawdź, czy iPhone jest włączony i w tej samej sieci Wi‑Fi co ten telewizor. Jeśli obraz nie wróci, ponownie stuknij „Cast to TV”."], "unreachable": ["Nie można połączyć się z iPhone’em", "iPhone i telewizor muszą być w tej samej sieci Wi‑Fi. Sieci gości i firmowe często to blokują."], "steps": ["Połącz iPhone’a z tą samą siecią Wi‑Fi co telewizor", "Otwórz Screen Mirror na iPhonie", "Stuknij „Cast to TV”"], "chip": "iPhone połączony", "badgeStall": "Ponowne łączenie…", "badgePaused": "Wstrzymano na iPhonie", "mediaError": ["Nie można odtworzyć", "Tego zdjęcia lub filmu nie można wyświetlić na tym telewizorze. Spróbuj innego na iPhonie."]},
    hi: {"ready": ["कास्ट करने के लिए तैयार", "अपने iPhone पर Screen Mirror खोलें और “Cast to TV” पर टैप करें।"], "connected": ["कनेक्ट हो गया", "आपकी कास्टिंग शुरू हो रही है…"], "stopped": ["कास्टिंग बंद हो गई", "फिर से शुरू करने के लिए अपने iPhone पर “Cast to TV” पर टैप करें।"], "lost": ["कनेक्शन टूट गया", "देखें कि आपका iPhone और TV एक ही Wi‑Fi पर हैं, फिर दोबारा “Cast to TV” पर टैप करें।"], "reconnecting": ["फिर से कनेक्ट हो रहा है…", "अपने iPhone पर Screen Mirror खुला रखें।"], "waitingForStart": ["कास्ट करने के लिए तैयार", "आपका iPhone कनेक्ट है। ऐप में “Start Casting” पर टैप करें।"], "stalledLost": ["आपके iPhone का इंतज़ार है", "देखें कि आपका iPhone चालू है और इस TV वाले Wi‑Fi से जुड़ा है। अगर तस्वीर वापस न आए, तो दोबारा “Cast to TV” पर टैप करें।"], "unreachable": ["आपके iPhone तक नहीं पहुँच पा रहे", "आपका iPhone और TV एक ही Wi‑Fi पर होने चाहिए। गेस्ट और ऑफ़िस नेटवर्क अक्सर इसे ब्लॉक करते हैं।"], "steps": ["अपने iPhone को इस TV वाले Wi‑Fi से कनेक्ट करें", "अपने iPhone पर Screen Mirror खोलें", "“Cast to TV” पर टैप करें"], "chip": "iPhone कनेक्ट है", "badgeStall": "फिर से कनेक्ट हो रहा है…", "badgePaused": "आपके iPhone पर रुका है", "mediaError": ["इसे चलाया नहीं जा सकता", "यह फ़ोटो या वीडियो इस TV पर नहीं दिखाया जा सकता। अपने iPhone पर कोई दूसरा आज़माएँ।"]},
    ja: {"ready": ["キャストの準備ができました", "iPhoneで「Screen Mirror」を開き、「Cast to TV」をタップしてください。"], "connected": ["接続しました", "キャストを開始しています…"], "stopped": ["キャストを停止しました", "もう一度始めるには、iPhoneで「Cast to TV」をタップしてください。"], "lost": ["接続が切れました", "iPhoneとテレビが同じWi‑Fiにつながっているか確認してから、もう一度「Cast to TV」をタップしてください。"], "reconnecting": ["再接続しています…", "iPhoneで「Screen Mirror」を開いたままにしてください。"], "waitingForStart": ["キャストの準備ができました", "iPhoneが接続されています。アプリで「Start Casting」をタップしてください。"], "stalledLost": ["iPhoneを待っています", "iPhoneの電源が入っていて、このテレビと同じWi‑Fiにつながっているか確認してください。戻らない場合は、もう一度「Cast to TV」をタップしてください。"], "unreachable": ["iPhoneに接続できません", "iPhoneとテレビを同じWi‑Fiにつなぐ必要があります。ゲスト用や会社のネットワークではブロックされることがあります。"], "steps": ["iPhoneをこのテレビと同じWi‑Fiにつなぐ", "iPhoneで「Screen Mirror」を開く", "「Cast to TV」をタップ"], "chip": "iPhone接続中", "badgeStall": "再接続しています…", "badgePaused": "iPhoneで一時停止中", "mediaError": ["再生できません", "この写真または動画はこのテレビでは表示できません。iPhoneで別のものをお試しください。"]},
    ko: {"ready": ["캐스트 준비 완료", "iPhone에서 Screen Mirror를 열고 ‘Cast to TV’를 탭하세요."], "connected": ["연결됨", "캐스트를 시작하는 중…"], "stopped": ["캐스트 중지됨", "다시 시작하려면 iPhone에서 ‘Cast to TV’를 탭하세요."], "lost": ["연결 끊김", "iPhone과 TV가 같은 Wi‑Fi에 연결되어 있는지 확인한 후 ‘Cast to TV’를 다시 탭하세요."], "reconnecting": ["다시 연결하는 중…", "iPhone에서 Screen Mirror를 열어 두세요."], "waitingForStart": ["캐스트 준비 완료", "iPhone이 연결되었습니다. 앱에서 ‘Start Casting’을 탭하세요."], "stalledLost": ["iPhone을 기다리는 중", "iPhone이 켜져 있고 이 TV와 같은 Wi‑Fi에 연결되어 있는지 확인하세요. 돌아오지 않으면 ‘Cast to TV’를 다시 탭하세요."], "unreachable": ["iPhone에 연결할 수 없음", "iPhone과 TV가 같은 Wi‑Fi에 있어야 합니다. 게스트 및 회사 네트워크에서는 이 기능이 차단되는 경우가 많습니다."], "steps": ["iPhone을 이 TV와 같은 Wi‑Fi에 연결", "iPhone에서 Screen Mirror 열기", "‘Cast to TV’ 탭"], "chip": "iPhone 연결됨", "badgeStall": "다시 연결하는 중…", "badgePaused": "iPhone에서 일시정지됨", "mediaError": ["재생할 수 없음", "이 사진이나 동영상은 이 TV에서 표시할 수 없습니다. iPhone에서 다른 항목을 시도해 보세요."]},
    zh: {"ready": ["准备投屏", "在 iPhone 上打开 Screen Mirror，然后轻点“Cast to TV”。"], "connected": ["已连接", "正在开始投屏…"], "stopped": ["投屏已停止", "在 iPhone 上轻点“Cast to TV”即可重新开始。"], "lost": ["连接已断开", "请确认 iPhone 和电视连接到同一 Wi‑Fi，然后再次轻点“Cast to TV”。"], "reconnecting": ["正在重新连接…", "请在 iPhone 上保持 Screen Mirror 打开。"], "waitingForStart": ["准备投屏", "iPhone 已连接。请在 App 中轻点“Start Casting”。"], "stalledLost": ["正在等待你的 iPhone", "请确认 iPhone 已开启，并与这台电视连接到同一 Wi‑Fi。如果画面没有恢复，请再次轻点“Cast to TV”。"], "unreachable": ["无法连接到你的 iPhone", "iPhone 和电视需要连接到同一 Wi‑Fi。访客网络和办公网络通常会阻止此功能。"], "steps": ["将 iPhone 连接到与这台电视相同的 Wi‑Fi", "在 iPhone 上打开 Screen Mirror", "轻点“Cast to TV”"], "chip": "iPhone 已连接", "badgeStall": "正在重新连接…", "badgePaused": "已在 iPhone 上暂停", "mediaError": ["无法播放", "这张照片或这个视频无法在这台电视上显示。请在 iPhone 上换一个试试。"]},
    "zh-hant": {"ready": ["準備投放", "在 iPhone 上打開 Screen Mirror，然後點一下「Cast to TV」。"], "connected": ["已連線", "正在開始投放…"], "stopped": ["已停止投放", "在 iPhone 上點一下「Cast to TV」即可重新開始。"], "lost": ["連線中斷", "請確認 iPhone 和電視連上同一個 Wi‑Fi，然後再次點一下「Cast to TV」。"], "reconnecting": ["正在重新連線…", "請在 iPhone 上讓 Screen Mirror 保持開啟。"], "waitingForStart": ["準備投放", "iPhone 已連線。請在 App 中點一下「Start Casting」。"], "stalledLost": ["正在等待你的 iPhone", "請確認 iPhone 已開啟，並與這台電視連上同一個 Wi‑Fi。如果畫面沒有恢復，請再次點一下「Cast to TV」。"], "unreachable": ["無法連線到你的 iPhone", "iPhone 和電視必須連上同一個 Wi‑Fi。訪客網路和公司網路經常會封鎖此功能。"], "steps": ["將 iPhone 連上與這台電視相同的 Wi‑Fi", "在 iPhone 上打開 Screen Mirror", "點一下「Cast to TV」"], "chip": "iPhone 已連線", "badgeStall": "正在重新連線…", "badgePaused": "已在 iPhone 上暫停", "mediaError": ["無法播放", "這張照片或這段影片無法在這台電視上顯示。請在 iPhone 上換一個試試。"]},
    ru: {"ready": ["Готово к трансляции", "На iPhone откройте Screen Mirror и нажмите «Cast to TV»."], "connected": ["Подключено", "Запускаем трансляцию…"], "stopped": ["Трансляция остановлена", "Чтобы начать снова, нажмите «Cast to TV» на iPhone."], "lost": ["Соединение потеряно", "Убедитесь, что iPhone и телевизор подключены к одной сети Wi‑Fi, и снова нажмите «Cast to TV»."], "reconnecting": ["Повторное подключение…", "Не закрывайте Screen Mirror на iPhone."], "waitingForStart": ["Готово к трансляции", "iPhone подключен. Нажмите «Start Casting» в приложении."], "stalledLost": ["Ожидание iPhone", "Убедитесь, что iPhone включен и подключен к той же сети Wi‑Fi, что и этот телевизор. Если изображение не вернется, снова нажмите «Cast to TV»."], "unreachable": ["Не удается связаться с iPhone", "iPhone и телевизор должны быть в одной сети Wi‑Fi. Гостевые и офисные сети часто это блокируют."], "steps": ["Подключите iPhone к той же сети Wi‑Fi, что и этот телевизор", "Откройте Screen Mirror на iPhone", "Нажмите «Cast to TV»"], "chip": "iPhone подключен", "badgeStall": "Повторное подключение…", "badgePaused": "Пауза на iPhone", "mediaError": ["Не удается воспроизвести", "Это фото или видео нельзя показать на этом телевизоре. Попробуйте другое на iPhone."]},
    uk: {"ready": ["Готово до трансляції", "На iPhone відкрийте Screen Mirror і торкніться «Cast to TV»."], "connected": ["Підключено", "Запускаємо трансляцію…"], "stopped": ["Трансляцію зупинено", "Щоб почати знову, торкніться «Cast to TV» на iPhone."], "lost": ["З’єднання втрачено", "Переконайтеся, що iPhone і телевізор підключені до однієї мережі Wi‑Fi, і знову торкніться «Cast to TV»."], "reconnecting": ["Повторне підключення…", "Не закривайте Screen Mirror на iPhone."], "waitingForStart": ["Готово до трансляції", "iPhone підключено. Торкніться «Start Casting» у застосунку."], "stalledLost": ["Очікування iPhone", "Переконайтеся, що iPhone увімкнений і підключений до тієї ж мережі Wi‑Fi, що й цей телевізор. Якщо зображення не повернеться, знову торкніться «Cast to TV»."], "unreachable": ["Не вдається зв’язатися з iPhone", "iPhone і телевізор мають бути в одній мережі Wi‑Fi. Гостьові й офісні мережі часто це блокують."], "steps": ["Підключіть iPhone до тієї ж мережі Wi‑Fi, що й цей телевізор", "Відкрийте Screen Mirror на iPhone", "Торкніться «Cast to TV»"], "chip": "iPhone підключено", "badgeStall": "Повторне підключення…", "badgePaused": "Пауза на iPhone", "mediaError": ["Не вдається відтворити", "Це фото чи відео не можна показати на цьому телевізорі. Спробуйте інше на iPhone."]},
    vi: {"ready": ["Sẵn sàng truyền", "Trên iPhone, mở Screen Mirror và chạm vào “Cast to TV”."], "connected": ["Đã kết nối", "Đang bắt đầu truyền…"], "stopped": ["Đã dừng truyền", "Chạm vào “Cast to TV” trên iPhone để bắt đầu lại."], "lost": ["Mất kết nối", "Hãy kiểm tra iPhone và TV đang dùng cùng một mạng Wi‑Fi, sau đó chạm lại vào “Cast to TV”."], "reconnecting": ["Đang kết nối lại…", "Hãy để Screen Mirror mở trên iPhone."], "waitingForStart": ["Sẵn sàng truyền", "iPhone đã kết nối. Chạm vào “Start Casting” trong ứng dụng."], "stalledLost": ["Đang chờ iPhone của bạn", "Hãy kiểm tra iPhone đang bật và dùng cùng mạng Wi‑Fi với TV này. Nếu hình ảnh không quay lại, hãy chạm lại vào “Cast to TV”."], "unreachable": ["Không thể kết nối với iPhone", "iPhone và TV cần dùng cùng một mạng Wi‑Fi. Mạng khách và mạng văn phòng thường chặn việc này."], "steps": ["Kết nối iPhone với cùng mạng Wi‑Fi như TV này", "Mở Screen Mirror trên iPhone", "Chạm vào “Cast to TV”"], "chip": "Đã kết nối iPhone", "badgeStall": "Đang kết nối lại…", "badgePaused": "Đã tạm dừng trên iPhone", "mediaError": ["Không thể phát", "Không thể hiển thị ảnh hoặc video này trên TV này. Hãy thử một mục khác trên iPhone."]},
    th: {"ready": ["พร้อมแคสต์", "บน iPhone ให้เปิด Screen Mirror แล้วแตะ “Cast to TV”"], "connected": ["เชื่อมต่อแล้ว", "กำลังเริ่มแคสต์…"], "stopped": ["หยุดแคสต์แล้ว", "แตะ “Cast to TV” บน iPhone เพื่อเริ่มใหม่"], "lost": ["การเชื่อมต่อขาดหาย", "ตรวจสอบว่า iPhone และทีวีใช้ Wi‑Fi เดียวกัน แล้วแตะ “Cast to TV” อีกครั้ง"], "reconnecting": ["กำลังเชื่อมต่อใหม่…", "เปิด Screen Mirror ค้างไว้บน iPhone"], "waitingForStart": ["พร้อมแคสต์", "เชื่อมต่อ iPhone แล้ว แตะ “Start Casting” ในแอป"], "stalledLost": ["กำลังรอ iPhone ของคุณ", "ตรวจสอบว่า iPhone เปิดอยู่และใช้ Wi‑Fi เดียวกับทีวีเครื่องนี้ หากภาพไม่กลับมา ให้แตะ “Cast to TV” อีกครั้ง"], "unreachable": ["เชื่อมต่อ iPhone ไม่ได้", "iPhone และทีวีต้องใช้ Wi‑Fi เดียวกัน เครือข่ายสำหรับแขกและเครือข่ายสำนักงานมักบล็อกการเชื่อมต่อนี้"], "steps": ["เชื่อมต่อ iPhone กับ Wi‑Fi เดียวกับทีวีเครื่องนี้", "เปิด Screen Mirror บน iPhone", "แตะ “Cast to TV”"], "chip": "เชื่อมต่อ iPhone แล้ว", "badgeStall": "กำลังเชื่อมต่อใหม่…", "badgePaused": "หยุดชั่วคราวบน iPhone", "mediaError": ["เล่นไม่ได้", "ไม่สามารถแสดงรูปภาพหรือวิดีโอนี้บนทีวีเครื่องนี้ได้ ลองรายการอื่นบน iPhone"]},
    ms: {"ready": ["Sedia untuk Cast", "Pada iPhone anda, buka Screen Mirror dan ketik “Cast to TV”."], "connected": ["Disambungkan", "Memulakan cast…"], "stopped": ["Cast Dihentikan", "Ketik “Cast to TV” pada iPhone anda untuk bermula semula."], "lost": ["Sambungan Terputus", "Pastikan iPhone dan TV anda menggunakan Wi‑Fi yang sama, kemudian ketik “Cast to TV” sekali lagi."], "reconnecting": ["Menyambung semula…", "Biarkan Screen Mirror terbuka pada iPhone anda."], "waitingForStart": ["Sedia untuk Cast", "iPhone anda telah disambungkan. Ketik “Start Casting” dalam apl."], "stalledLost": ["Menunggu iPhone Anda", "Pastikan iPhone anda dihidupkan dan menggunakan Wi‑Fi yang sama dengan TV ini. Jika tidak kembali, ketik “Cast to TV” sekali lagi."], "unreachable": ["Tidak Dapat Menghubungi iPhone Anda", "iPhone dan TV anda perlu berada pada Wi‑Fi yang sama. Rangkaian tetamu dan pejabat sering menyekat ini."], "steps": ["Sambungkan iPhone anda ke Wi‑Fi yang sama dengan TV ini", "Buka Screen Mirror pada iPhone anda", "Ketik “Cast to TV”"], "chip": "iPhone disambungkan", "badgeStall": "Menyambung semula…", "badgePaused": "Dijeda pada iPhone anda", "mediaError": ["Tidak Dapat Dimainkan", "Foto atau video ini tidak dapat dipaparkan pada TV ini. Cuba yang lain pada iPhone anda."]},
    fil: {"ready": ["Handa nang Mag-cast", "Sa iPhone mo, buksan ang Screen Mirror at i-tap ang “Cast to TV”."], "connected": ["Nakakonekta", "Sinisimulan ang pag-cast…"], "stopped": ["Huminto ang Pag-cast", "I-tap ang “Cast to TV” sa iPhone mo para magsimula ulit."], "lost": ["Nawala ang Koneksyon", "Tiyaking nasa iisang Wi‑Fi ang iPhone at TV mo, pagkatapos ay i-tap ulit ang “Cast to TV”."], "reconnecting": ["Kumokonekta ulit…", "Panatilihing bukas ang Screen Mirror sa iPhone mo."], "waitingForStart": ["Handa nang Mag-cast", "Nakakonekta na ang iPhone mo. I-tap ang “Start Casting” sa app."], "stalledLost": ["Hinihintay ang iPhone Mo", "Tiyaking naka-on ang iPhone mo at nasa iisang Wi‑Fi kasama ng TV na ito. Kung hindi ito bumalik, i-tap ulit ang “Cast to TV”."], "unreachable": ["Hindi Maabot ang iPhone Mo", "Dapat nasa iisang Wi‑Fi ang iPhone at TV mo. Madalas itong hinaharangan ng guest at office network."], "steps": ["Ikonekta ang iPhone mo sa parehong Wi‑Fi ng TV na ito", "Buksan ang Screen Mirror sa iPhone mo", "I-tap ang “Cast to TV”"], "chip": "Nakakonekta ang iPhone", "badgeStall": "Kumokonekta ulit…", "badgePaused": "Naka-pause sa iPhone mo", "mediaError": ["Hindi Ito Ma-play", "Hindi maipakita ang larawan o video na ito sa TV na ito. Sumubok ng iba sa iPhone mo."]},
    sv: {"ready": ["Redo att casta", "Öppna Screen Mirror på din iPhone och tryck på ”Cast to TV”."], "connected": ["Ansluten", "Startar castningen…"], "stopped": ["Castningen stoppad", "Tryck på ”Cast to TV” på din iPhone för att börja igen."], "lost": ["Anslutningen bröts", "Kontrollera att din iPhone och tv:n är på samma Wi‑Fi och tryck sedan på ”Cast to TV” igen."], "reconnecting": ["Ansluter igen…", "Håll Screen Mirror öppen på din iPhone."], "waitingForStart": ["Redo att casta", "Din iPhone är ansluten. Tryck på ”Start Casting” i appen."], "stalledLost": ["Väntar på din iPhone", "Kontrollera att din iPhone är på och ansluten till samma Wi‑Fi som den här tv:n. Om bilden inte kommer tillbaka trycker du på ”Cast to TV” igen."], "unreachable": ["Når inte din iPhone", "Din iPhone och tv:n måste vara på samma Wi‑Fi. Gäst- och kontorsnätverk blockerar ofta detta."], "steps": ["Anslut din iPhone till samma Wi‑Fi som den här tv:n", "Öppna Screen Mirror på din iPhone", "Tryck på ”Cast to TV”"], "chip": "iPhone ansluten", "badgeStall": "Ansluter igen…", "badgePaused": "Pausad på din iPhone", "mediaError": ["Kan inte spela upp", "Det här fotot eller videoklippet kan inte visas på den här tv:n. Prova ett annat på din iPhone."]},
    da: {"ready": ["Klar til at caste", "Åbn Screen Mirror på din iPhone, og tryk på “Cast to TV”."], "connected": ["Forbundet", "Starter din casting…"], "stopped": ["Casting stoppet", "Tryk på “Cast to TV” på din iPhone for at starte igen."], "lost": ["Forbindelsen blev afbrudt", "Tjek, at din iPhone og dit tv er på samme Wi‑Fi, og tryk derefter på “Cast to TV” igen."], "reconnecting": ["Opretter forbindelse igen…", "Hold Screen Mirror åben på din iPhone."], "waitingForStart": ["Klar til at caste", "Din iPhone er forbundet. Tryk på “Start Casting” i appen."], "stalledLost": ["Venter på din iPhone", "Tjek, at din iPhone er tændt og på samme Wi‑Fi som dette tv. Hvis billedet ikke kommer tilbage, skal du trykke på “Cast to TV” igen."], "unreachable": ["Kan ikke nå din iPhone", "Din iPhone og dit tv skal være på samme Wi‑Fi. Gæste- og kontornetværk blokerer ofte dette."], "steps": ["Forbind din iPhone til samme Wi‑Fi som dette tv", "Åbn Screen Mirror på din iPhone", "Tryk på “Cast to TV”"], "chip": "iPhone forbundet", "badgeStall": "Opretter forbindelse igen…", "badgePaused": "Sat på pause på din iPhone", "mediaError": ["Kan ikke afspilles", "Dette foto eller denne video kan ikke vises på dette tv. Prøv et andet på din iPhone."]},
    nb: {"ready": ["Klar til å caste", "Åpne Screen Mirror på iPhonen og trykk på «Cast to TV»."], "connected": ["Tilkoblet", "Starter castingen…"], "stopped": ["Castingen er stoppet", "Trykk på «Cast to TV» på iPhonen for å starte igjen."], "lost": ["Tilkoblingen ble brutt", "Sjekk at iPhonen og TV-en er på samme Wi‑Fi, og trykk deretter på «Cast to TV» igjen."], "reconnecting": ["Kobler til igjen…", "La Screen Mirror være åpen på iPhonen."], "waitingForStart": ["Klar til å caste", "iPhonen er tilkoblet. Trykk på «Start Casting» i appen."], "stalledLost": ["Venter på iPhonen", "Sjekk at iPhonen er på og koblet til samme Wi‑Fi som denne TV-en. Hvis bildet ikke kommer tilbake, trykker du på «Cast to TV» igjen."], "unreachable": ["Når ikke iPhonen", "iPhonen og TV-en må være på samme Wi‑Fi. Gjeste- og kontornettverk blokkerer ofte dette."], "steps": ["Koble iPhonen til samme Wi‑Fi som denne TV-en", "Åpne Screen Mirror på iPhonen", "Trykk på «Cast to TV»"], "chip": "iPhone tilkoblet", "badgeStall": "Kobler til igjen…", "badgePaused": "Satt på pause på iPhonen", "mediaError": ["Kan ikke spilles av", "Dette bildet eller denne videoen kan ikke vises på denne TV-en. Prøv en annen på iPhonen."]},
    fi: {"ready": ["Valmis suoratoistoon", "Avaa iPhonessa Screen Mirror ja napauta ”Cast to TV”."], "connected": ["Yhdistetty", "Aloitetaan suoratoisto…"], "stopped": ["Suoratoisto lopetettu", "Aloita uudelleen napauttamalla iPhonessa ”Cast to TV”."], "lost": ["Yhteys katkesi", "Varmista, että iPhone ja televisio ovat samassa Wi‑Fi-verkossa, ja napauta sitten uudelleen ”Cast to TV”."], "reconnecting": ["Yhdistetään uudelleen…", "Pidä Screen Mirror auki iPhonessa."], "waitingForStart": ["Valmis suoratoistoon", "iPhone on yhdistetty. Napauta sovelluksessa ”Start Casting”."], "stalledLost": ["Odotetaan iPhonea", "Varmista, että iPhone on päällä ja samassa Wi‑Fi-verkossa kuin tämä televisio. Jos kuva ei palaa, napauta uudelleen ”Cast to TV”."], "unreachable": ["iPhoneen ei saada yhteyttä", "iPhonen ja television on oltava samassa Wi‑Fi-verkossa. Vieras- ja toimistoverkot estävät tämän usein."], "steps": ["Yhdistä iPhone samaan Wi‑Fi-verkkoon kuin tämä televisio", "Avaa Screen Mirror iPhonessa", "Napauta ”Cast to TV”"], "chip": "iPhone yhdistetty", "badgeStall": "Yhdistetään uudelleen…", "badgePaused": "Keskeytetty iPhonessa", "mediaError": ["Toisto ei onnistu", "Tätä kuvaa tai videota ei voi näyttää tässä televisiossa. Kokeile toista iPhonessa."]},
    cs: {"ready": ["Připraveno k přenosu", "Na iPhonu otevřete Screen Mirror a klepněte na „Cast to TV“."], "connected": ["Připojeno", "Zahajuje se přenos…"], "stopped": ["Přenos zastaven", "Pro nové spuštění klepněte na iPhonu na „Cast to TV“."], "lost": ["Spojení ztraceno", "Zkontrolujte, že jsou iPhone a televize na stejné síti Wi‑Fi, a pak znovu klepněte na „Cast to TV“."], "reconnecting": ["Znovu se připojuje…", "Nechte Screen Mirror na iPhonu otevřený."], "waitingForStart": ["Připraveno k přenosu", "iPhone je připojený. V aplikaci klepněte na „Start Casting“."], "stalledLost": ["Čeká se na iPhone", "Zkontrolujte, že je iPhone zapnutý a na stejné síti Wi‑Fi jako tato televize. Pokud se obraz nevrátí, znovu klepněte na „Cast to TV“."], "unreachable": ["iPhone není dostupný", "iPhone a televize musí být na stejné síti Wi‑Fi. Sítě pro hosty a firemní sítě to často blokují."], "steps": ["Připojte iPhone ke stejné síti Wi‑Fi jako tuto televizi", "Otevřete Screen Mirror na iPhonu", "Klepněte na „Cast to TV“"], "chip": "iPhone připojen", "badgeStall": "Znovu se připojuje…", "badgePaused": "Pozastaveno na iPhonu", "mediaError": ["Nelze přehrát", "Tuto fotku nebo video nelze na této televizi zobrazit. Zkuste na iPhonu jinou."]},
    ro: {"ready": ["Gata de difuzare", "Pe iPhone, deschide Screen Mirror și atinge „Cast to TV”."], "connected": ["Conectat", "Se pornește difuzarea…"], "stopped": ["Difuzare oprită", "Atinge „Cast to TV” pe iPhone pentru a începe din nou."], "lost": ["Conexiune pierdută", "Verifică dacă iPhone-ul și televizorul sunt în aceeași rețea Wi‑Fi, apoi atinge din nou „Cast to TV”."], "reconnecting": ["Se reconectează…", "Ține Screen Mirror deschisă pe iPhone."], "waitingForStart": ["Gata de difuzare", "iPhone-ul este conectat. Atinge „Start Casting” în aplicație."], "stalledLost": ["Se așteaptă iPhone-ul", "Verifică dacă iPhone-ul este pornit și în aceeași rețea Wi‑Fi ca acest televizor. Dacă imaginea nu revine, atinge din nou „Cast to TV”."], "unreachable": ["iPhone-ul nu poate fi accesat", "iPhone-ul și televizorul trebuie să fie în aceeași rețea Wi‑Fi. Rețelele pentru oaspeți și cele de birou blochează adesea acest lucru."], "steps": ["Conectează iPhone-ul la aceeași rețea Wi‑Fi ca acest televizor", "Deschide Screen Mirror pe iPhone", "Atinge „Cast to TV”"], "chip": "iPhone conectat", "badgeStall": "Se reconectează…", "badgePaused": "Pus pe pauză pe iPhone", "mediaError": ["Nu se poate reda", "Această fotografie sau acest videoclip nu poate fi afișat pe acest televizor. Încearcă altceva pe iPhone."]},
    hu: {"ready": ["Készen áll a kivetítésre", "Az iPhone-on nyisd meg a Screen Mirrort, és koppints a „Cast to TV” gombra."], "connected": ["Csatlakoztatva", "Kivetítés indítása…"], "stopped": ["Kivetítés leállítva", "Az újrakezdéshez koppints az iPhone-on a „Cast to TV” gombra."], "lost": ["Megszakadt a kapcsolat", "Ellenőrizd, hogy az iPhone és a tévé ugyanazon a Wi‑Fi-hálózaton van, majd koppints újra a „Cast to TV” gombra."], "reconnecting": ["Újracsatlakozás…", "Tartsd nyitva a Screen Mirrort az iPhone-on."], "waitingForStart": ["Készen áll a kivetítésre", "Az iPhone csatlakoztatva van. Koppints az appban a „Start Casting” gombra."], "stalledLost": ["Várakozás az iPhone-ra", "Ellenőrizd, hogy az iPhone be van kapcsolva, és ugyanazon a Wi‑Fi-hálózaton van, mint ez a tévé. Ha a kép nem tér vissza, koppints újra a „Cast to TV” gombra."], "unreachable": ["Az iPhone nem érhető el", "Az iPhone-nak és a tévének ugyanazon a Wi‑Fi-hálózaton kell lennie. A vendég- és irodai hálózatok ezt gyakran tiltják."], "steps": ["Csatlakoztasd az iPhone-t ugyanahhoz a Wi‑Fi-hálózathoz, mint ezt a tévét", "Nyisd meg a Screen Mirrort az iPhone-on", "Koppints a „Cast to TV” gombra"], "chip": "iPhone csatlakoztatva", "badgeStall": "Újracsatlakozás…", "badgePaused": "Szüneteltetve az iPhone-on", "mediaError": ["Nem játszható le", "Ez a fotó vagy videó nem jeleníthető meg ezen a tévén. Próbálj ki egy másikat az iPhone-on."]},
    el: {"ready": ["Έτοιμο για μετάδοση", "Στο iPhone, ανοίξτε το Screen Mirror και πατήστε «Cast to TV»."], "connected": ["Συνδέθηκε", "Ξεκινά η μετάδοση…"], "stopped": ["Η μετάδοση σταμάτησε", "Πατήστε «Cast to TV» στο iPhone για να ξεκινήσετε ξανά."], "lost": ["Η σύνδεση χάθηκε", "Ελέγξτε ότι το iPhone και η τηλεόραση είναι στο ίδιο Wi‑Fi και, στη συνέχεια, πατήστε ξανά «Cast to TV»."], "reconnecting": ["Επανασύνδεση…", "Αφήστε το Screen Mirror ανοιχτό στο iPhone."], "waitingForStart": ["Έτοιμο για μετάδοση", "Το iPhone είναι συνδεδεμένο. Πατήστε «Start Casting» στην εφαρμογή."], "stalledLost": ["Αναμονή για το iPhone σας", "Ελέγξτε ότι το iPhone είναι ενεργό και στο ίδιο Wi‑Fi με αυτή την τηλεόραση. Αν η εικόνα δεν επανέλθει, πατήστε ξανά «Cast to TV»."], "unreachable": ["Δεν είναι δυνατή η σύνδεση με το iPhone", "Το iPhone και η τηλεόραση πρέπει να είναι στο ίδιο Wi‑Fi. Τα δίκτυα επισκεπτών και γραφείου συχνά το εμποδίζουν."], "steps": ["Συνδέστε το iPhone στο ίδιο Wi‑Fi με αυτή την τηλεόραση", "Ανοίξτε το Screen Mirror στο iPhone", "Πατήστε «Cast to TV»"], "chip": "Το iPhone συνδέθηκε", "badgeStall": "Επανασύνδεση…", "badgePaused": "Σε παύση στο iPhone", "mediaError": ["Δεν είναι δυνατή η αναπαραγωγή", "Αυτή η φωτογραφία ή το βίντεο δεν μπορεί να εμφανιστεί σε αυτή την τηλεόραση. Δοκιμάστε κάτι άλλο στο iPhone."]},
    mr: {"ready": ["कास्ट करण्यासाठी तयार", "तुमच्या iPhone वर Screen Mirror उघडा आणि “Cast to TV” वर टॅप करा."], "connected": ["कनेक्ट झाले", "कास्ट सुरू होत आहे…"], "stopped": ["कास्टिंग थांबले", "पुन्हा सुरू करण्यासाठी iPhone वर “Cast to TV” वर टॅप करा."], "lost": ["कनेक्शन तुटले", "तुमचा iPhone आणि TV एकाच Wi‑Fi वर आहेत का ते तपासा, नंतर पुन्हा “Cast to TV” वर टॅप करा."], "reconnecting": ["पुन्हा कनेक्ट होत आहे…", "तुमच्या iPhone वर Screen Mirror उघडे ठेवा."], "waitingForStart": ["कास्ट करण्यासाठी तयार", "तुमचा iPhone कनेक्ट झाला आहे. अ‍ॅपमध्ये “Start Casting” वर टॅप करा."], "stalledLost": ["तुमच्या iPhone ची वाट पाहत आहे", "तुमचा iPhone चालू आहे आणि या TV च्या Wi‑Fi शी जोडलेला आहे का ते तपासा. चित्र परत न आल्यास, पुन्हा “Cast to TV” वर टॅप करा."], "unreachable": ["तुमच्या iPhone शी संपर्क होत नाही", "तुमचा iPhone आणि TV एकाच Wi‑Fi वर असणे आवश्यक आहे. गेस्ट आणि ऑफिस नेटवर्क अनेकदा हे ब्लॉक करतात."], "steps": ["तुमचा iPhone या TV च्या Wi‑Fi शी जोडा", "तुमच्या iPhone वर Screen Mirror उघडा", "“Cast to TV” वर टॅप करा"], "chip": "iPhone कनेक्ट झाला", "badgeStall": "पुन्हा कनेक्ट होत आहे…", "badgePaused": "iPhone वर थांबवले", "mediaError": ["हे प्ले करता येत नाही", "हा फोटो किंवा व्हिडिओ या TV वर दाखवता येत नाही. तुमच्या iPhone वर दुसरा वापरून पहा."]},
    ta: {"ready": ["காஸ்ட் செய்யத் தயார்", "உங்கள் iPhone-இல் Screen Mirror-ஐத் திறந்து “Cast to TV”-ஐத் தட்டவும்."], "connected": ["இணைக்கப்பட்டது", "காஸ்ட் தொடங்குகிறது…"], "stopped": ["காஸ்ட் நிறுத்தப்பட்டது", "மீண்டும் தொடங்க உங்கள் iPhone-இல் “Cast to TV”-ஐத் தட்டவும்."], "lost": ["இணைப்பு துண்டிக்கப்பட்டது", "உங்கள் iPhone-உம் TV-யும் ஒரே Wi‑Fi-இல் உள்ளனவா எனச் சரிபார்த்து, மீண்டும் “Cast to TV”-ஐத் தட்டவும்."], "reconnecting": ["மீண்டும் இணைக்கிறது…", "உங்கள் iPhone-இல் Screen Mirror-ஐத் திறந்தே வைத்திருங்கள்."], "waitingForStart": ["காஸ்ட் செய்யத் தயார்", "உங்கள் iPhone இணைக்கப்பட்டது. ஆப்ஸில் “Start Casting”-ஐத் தட்டவும்."], "stalledLost": ["உங்கள் iPhone-க்காகக் காத்திருக்கிறது", "உங்கள் iPhone இயக்கத்தில் உள்ளதா, இந்த TV உள்ள அதே Wi‑Fi-இல் உள்ளதா எனச் சரிபார்க்கவும். படம் திரும்ப வரவில்லை எனில், மீண்டும் “Cast to TV”-ஐத் தட்டவும்."], "unreachable": ["உங்கள் iPhone-ஐ அணுக முடியவில்லை", "உங்கள் iPhone-உம் TV-யும் ஒரே Wi‑Fi-இல் இருக்க வேண்டும். விருந்தினர் மற்றும் அலுவலக நெட்வொர்க்குகள் இதை அடிக்கடி தடுக்கின்றன."], "steps": ["இந்த TV உள்ள அதே Wi‑Fi-உடன் உங்கள் iPhone-ஐ இணைக்கவும்", "உங்கள் iPhone-இல் Screen Mirror-ஐத் திறக்கவும்", "“Cast to TV”-ஐத் தட்டவும்"], "chip": "iPhone இணைக்கப்பட்டது", "badgeStall": "மீண்டும் இணைக்கிறது…", "badgePaused": "iPhone-இல் இடைநிறுத்தப்பட்டது", "mediaError": ["இதை இயக்க முடியவில்லை", "இந்தப் படத்தையோ வீடியோவையோ இந்த TV-இல் காட்ட முடியாது. உங்கள் iPhone-இல் வேறொன்றை முயலவும்."]},
    te: {"ready": ["క్యాస్ట్ చేయడానికి సిద్ధం", "మీ iPhone లో Screen Mirror ను తెరిచి “Cast to TV” ను నొక్కండి."], "connected": ["కనెక్ట్ అయింది", "క్యాస్ట్ ప్రారంభమవుతోంది…"], "stopped": ["క్యాస్టింగ్ ఆగిపోయింది", "మళ్లీ ప్రారంభించడానికి మీ iPhone లో “Cast to TV” ను నొక్కండి."], "lost": ["కనెక్షన్ పోయింది", "మీ iPhone మరియు TV ఒకే Wi‑Fi లో ఉన్నాయో లేదో తనిఖీ చేసి, మళ్లీ “Cast to TV” ను నొక్కండి."], "reconnecting": ["మళ్లీ కనెక్ట్ అవుతోంది…", "మీ iPhone లో Screen Mirror ను తెరిచే ఉంచండి."], "waitingForStart": ["క్యాస్ట్ చేయడానికి సిద్ధం", "మీ iPhone కనెక్ట్ అయింది. యాప్‌లో “Start Casting” ను నొక్కండి."], "stalledLost": ["మీ iPhone కోసం వేచి ఉంది", "మీ iPhone ఆన్‌లో ఉందో, ఈ TV ఉన్న Wi‑Fi లోనే ఉందో తనిఖీ చేయండి. చిత్రం తిరిగి రాకపోతే, మళ్లీ “Cast to TV” ను నొక్కండి."], "unreachable": ["మీ iPhone ను చేరుకోలేకపోయాము", "మీ iPhone మరియు TV ఒకే Wi‑Fi లో ఉండాలి. గెస్ట్ మరియు ఆఫీస్ నెట్‌వర్క్‌లు దీన్ని తరచుగా బ్లాక్ చేస్తాయి."], "steps": ["మీ iPhone ను ఈ TV ఉన్న Wi‑Fi కి కనెక్ట్ చేయండి", "మీ iPhone లో Screen Mirror ను తెరవండి", "“Cast to TV” ను నొక్కండి"], "chip": "iPhone కనెక్ట్ అయింది", "badgeStall": "మళ్లీ కనెక్ట్ అవుతోంది…", "badgePaused": "iPhone లో పాజ్ చేయబడింది", "mediaError": ["దీన్ని ప్లే చేయలేము", "ఈ ఫోటో లేదా వీడియోను ఈ TV లో చూపించలేము. మీ iPhone లో మరొకదాన్ని ప్రయత్నించండి."]},
    bn: {"ready": ["কাস্ট করার জন্য প্রস্তুত", "আপনার iPhone-এ Screen Mirror খুলুন এবং “Cast to TV” ট্যাপ করুন।"], "connected": ["সংযুক্ত", "কাস্ট শুরু হচ্ছে…"], "stopped": ["কাস্টিং বন্ধ হয়েছে", "আবার শুরু করতে আপনার iPhone-এ “Cast to TV” ট্যাপ করুন।"], "lost": ["সংযোগ বিচ্ছিন্ন", "আপনার iPhone এবং TV একই Wi‑Fi-এ আছে কিনা দেখুন, তারপর আবার “Cast to TV” ট্যাপ করুন।"], "reconnecting": ["আবার সংযোগ করা হচ্ছে…", "আপনার iPhone-এ Screen Mirror খোলা রাখুন।"], "waitingForStart": ["কাস্ট করার জন্য প্রস্তুত", "আপনার iPhone সংযুক্ত হয়েছে। অ্যাপে “Start Casting” ট্যাপ করুন।"], "stalledLost": ["আপনার iPhone-এর জন্য অপেক্ষা করা হচ্ছে", "আপনার iPhone চালু আছে এবং এই TV-র মতো একই Wi‑Fi-এ আছে কিনা দেখুন। ছবি ফিরে না এলে, আবার “Cast to TV” ট্যাপ করুন।"], "unreachable": ["আপনার iPhone-এ পৌঁছানো যাচ্ছে না", "আপনার iPhone এবং TV একই Wi‑Fi-এ থাকতে হবে। গেস্ট এবং অফিস নেটওয়ার্ক প্রায়ই এটি ব্লক করে।"], "steps": ["আপনার iPhone এই TV-র মতো একই Wi‑Fi-এ সংযুক্ত করুন", "আপনার iPhone-এ Screen Mirror খুলুন", "“Cast to TV” ট্যাপ করুন"], "chip": "iPhone সংযুক্ত", "badgeStall": "আবার সংযোগ করা হচ্ছে…", "badgePaused": "iPhone-এ বিরতি দেওয়া হয়েছে", "mediaError": ["এটি চালানো যাচ্ছে না", "এই ছবি বা ভিডিও এই TV-তে দেখানো যাবে না। আপনার iPhone-এ অন্য একটি চেষ্টা করুন।"]},
    gu: {"ready": ["કાસ્ટ કરવા માટે તૈયાર", "તમારા iPhone પર Screen Mirror ખોલો અને “Cast to TV” પર ટૅપ કરો."], "connected": ["કનેક્ટ થયું", "કાસ્ટ શરૂ થઈ રહ્યું છે…"], "stopped": ["કાસ્ટિંગ બંધ થયું", "ફરી શરૂ કરવા માટે તમારા iPhone પર “Cast to TV” પર ટૅપ કરો."], "lost": ["કનેક્શન તૂટી ગયું", "તમારો iPhone અને TV એક જ Wi‑Fi પર છે કે નહીં તે તપાસો, પછી ફરી “Cast to TV” પર ટૅપ કરો."], "reconnecting": ["ફરી કનેક્ટ થઈ રહ્યું છે…", "તમારા iPhone પર Screen Mirror ખુલ્લું રાખો."], "waitingForStart": ["કાસ્ટ કરવા માટે તૈયાર", "તમારો iPhone કનેક્ટ થયો છે. ઍપમાં “Start Casting” પર ટૅપ કરો."], "stalledLost": ["તમારા iPhone ની રાહ જોઈ રહ્યાં છીએ", "તમારો iPhone ચાલુ છે અને આ TV ના Wi‑Fi પર છે કે નહીં તે તપાસો. ચિત્ર પાછું ન આવે તો, ફરી “Cast to TV” પર ટૅપ કરો."], "unreachable": ["તમારા iPhone સુધી પહોંચી શકાતું નથી", "તમારો iPhone અને TV એક જ Wi‑Fi પર હોવા જરૂરી છે. ગેસ્ટ અને ઑફિસ નેટવર્ક ઘણીવાર આને બ્લૉક કરે છે."], "steps": ["તમારા iPhone ને આ TV ના Wi‑Fi સાથે કનેક્ટ કરો", "તમારા iPhone પર Screen Mirror ખોલો", "“Cast to TV” પર ટૅપ કરો"], "chip": "iPhone કનેક્ટ થયો", "badgeStall": "ફરી કનેક્ટ થઈ રહ્યું છે…", "badgePaused": "iPhone પર થોભાવ્યું", "mediaError": ["આ ચલાવી શકાતું નથી", "આ ફોટો અથવા વીડિયો આ TV પર બતાવી શકાતો નથી. તમારા iPhone પર બીજો અજમાવો."]},
    kn: {"ready": ["ಕ್ಯಾಸ್ಟ್ ಮಾಡಲು ಸಿದ್ಧ", "ನಿಮ್ಮ iPhone ನಲ್ಲಿ Screen Mirror ತೆರೆಯಿರಿ ಮತ್ತು “Cast to TV” ಟ್ಯಾಪ್ ಮಾಡಿ."], "connected": ["ಸಂಪರ್ಕಗೊಂಡಿದೆ", "ಕ್ಯಾಸ್ಟ್ ಪ್ರಾರಂಭವಾಗುತ್ತಿದೆ…"], "stopped": ["ಕ್ಯಾಸ್ಟಿಂಗ್ ನಿಲ್ಲಿಸಲಾಗಿದೆ", "ಮತ್ತೆ ಪ್ರಾರಂಭಿಸಲು ನಿಮ್ಮ iPhone ನಲ್ಲಿ “Cast to TV” ಟ್ಯಾಪ್ ಮಾಡಿ."], "lost": ["ಸಂಪರ್ಕ ಕಡಿದುಹೋಗಿದೆ", "ನಿಮ್ಮ iPhone ಮತ್ತು TV ಒಂದೇ Wi‑Fi ನಲ್ಲಿವೆಯೇ ಎಂದು ಪರಿಶೀಲಿಸಿ, ನಂತರ ಮತ್ತೆ “Cast to TV” ಟ್ಯಾಪ್ ಮಾಡಿ."], "reconnecting": ["ಮರುಸಂಪರ್ಕಿಸಲಾಗುತ್ತಿದೆ…", "ನಿಮ್ಮ iPhone ನಲ್ಲಿ Screen Mirror ತೆರೆದಿಡಿ."], "waitingForStart": ["ಕ್ಯಾಸ್ಟ್ ಮಾಡಲು ಸಿದ್ಧ", "ನಿಮ್ಮ iPhone ಸಂಪರ್ಕಗೊಂಡಿದೆ. ಆ್ಯಪ್‌ನಲ್ಲಿ “Start Casting” ಟ್ಯಾಪ್ ಮಾಡಿ."], "stalledLost": ["ನಿಮ್ಮ iPhone ಗಾಗಿ ಕಾಯಲಾಗುತ್ತಿದೆ", "ನಿಮ್ಮ iPhone ಆನ್ ಆಗಿದೆಯೇ ಮತ್ತು ಈ TV ಇರುವ Wi‑Fi ನಲ್ಲೇ ಇದೆಯೇ ಎಂದು ಪರಿಶೀಲಿಸಿ. ಚಿತ್ರ ಮರಳಿ ಬರದಿದ್ದರೆ, ಮತ್ತೆ “Cast to TV” ಟ್ಯಾಪ್ ಮಾಡಿ."], "unreachable": ["ನಿಮ್ಮ iPhone ತಲುಪಲು ಸಾಧ್ಯವಾಗುತ್ತಿಲ್ಲ", "ನಿಮ್ಮ iPhone ಮತ್ತು TV ಒಂದೇ Wi‑Fi ನಲ್ಲಿರಬೇಕು. ಅತಿಥಿ ಮತ್ತು ಕಚೇರಿ ನೆಟ್‌ವರ್ಕ್‌ಗಳು ಇದನ್ನು ಹೆಚ್ಚಾಗಿ ನಿರ್ಬಂಧಿಸುತ್ತವೆ."], "steps": ["ನಿಮ್ಮ iPhone ಅನ್ನು ಈ TV ಇರುವ Wi‑Fi ಗೆ ಸಂಪರ್ಕಿಸಿ", "ನಿಮ್ಮ iPhone ನಲ್ಲಿ Screen Mirror ತೆರೆಯಿರಿ", "“Cast to TV” ಟ್ಯಾಪ್ ಮಾಡಿ"], "chip": "iPhone ಸಂಪರ್ಕಗೊಂಡಿದೆ", "badgeStall": "ಮರುಸಂಪರ್ಕಿಸಲಾಗುತ್ತಿದೆ…", "badgePaused": "iPhone ನಲ್ಲಿ ವಿರಾಮಗೊಳಿಸಲಾಗಿದೆ", "mediaError": ["ಇದನ್ನು ಪ್ಲೇ ಮಾಡಲು ಸಾಧ್ಯವಿಲ್ಲ", "ಈ ಫೋಟೋ ಅಥವಾ ವೀಡಿಯೊವನ್ನು ಈ TV ಯಲ್ಲಿ ತೋರಿಸಲು ಸಾಧ್ಯವಿಲ್ಲ. ನಿಮ್ಮ iPhone ನಲ್ಲಿ ಬೇರೊಂದನ್ನು ಪ್ರಯತ್ನಿಸಿ."]},
    ml: {"ready": ["കാസ്റ്റ് ചെയ്യാൻ തയ്യാർ", "നിങ്ങളുടെ iPhone-ൽ Screen Mirror തുറന്ന് “Cast to TV” ടാപ്പ് ചെയ്യുക."], "connected": ["കണക്റ്റ് ചെയ്തു", "കാസ്റ്റ് ആരംഭിക്കുന്നു…"], "stopped": ["കാസ്റ്റിംഗ് നിർത്തി", "വീണ്ടും ആരംഭിക്കാൻ നിങ്ങളുടെ iPhone-ൽ “Cast to TV” ടാപ്പ് ചെയ്യുക."], "lost": ["കണക്ഷൻ നഷ്ടമായി", "നിങ്ങളുടെ iPhone-ഉം TV-യും ഒരേ Wi‑Fi-ൽ ആണോ എന്ന് പരിശോധിച്ച്, വീണ്ടും “Cast to TV” ടാപ്പ് ചെയ്യുക."], "reconnecting": ["വീണ്ടും കണക്റ്റ് ചെയ്യുന്നു…", "നിങ്ങളുടെ iPhone-ൽ Screen Mirror തുറന്നുവയ്ക്കുക."], "waitingForStart": ["കാസ്റ്റ് ചെയ്യാൻ തയ്യാർ", "നിങ്ങളുടെ iPhone കണക്റ്റ് ചെയ്തു. ആപ്പിൽ “Start Casting” ടാപ്പ് ചെയ്യുക."], "stalledLost": ["നിങ്ങളുടെ iPhone-നായി കാത്തിരിക്കുന്നു", "നിങ്ങളുടെ iPhone ഓണാണോ എന്നും ഈ TV-യുടെ അതേ Wi‑Fi-ൽ ആണോ എന്നും പരിശോധിക്കുക. ചിത്രം തിരികെ വന്നില്ലെങ്കിൽ, വീണ്ടും “Cast to TV” ടാപ്പ് ചെയ്യുക."], "unreachable": ["നിങ്ങളുടെ iPhone-ൽ എത്താനാകുന്നില്ല", "നിങ്ങളുടെ iPhone-ഉം TV-യും ഒരേ Wi‑Fi-ൽ ആയിരിക്കണം. ഗസ്റ്റ്, ഓഫീസ് നെറ്റ്‌വർക്കുകൾ പലപ്പോഴും ഇത് തടയാറുണ്ട്."], "steps": ["നിങ്ങളുടെ iPhone ഈ TV-യുടെ അതേ Wi‑Fi-ലേക്ക് കണക്റ്റ് ചെയ്യുക", "നിങ്ങളുടെ iPhone-ൽ Screen Mirror തുറക്കുക", "“Cast to TV” ടാപ്പ് ചെയ്യുക"], "chip": "iPhone കണക്റ്റ് ചെയ്തു", "badgeStall": "വീണ്ടും കണക്റ്റ് ചെയ്യുന്നു…", "badgePaused": "iPhone-ൽ താൽക്കാലികമായി നിർത്തി", "mediaError": ["ഇത് പ്ലേ ചെയ്യാനാകില്ല", "ഈ ഫോട്ടോയോ വീഡിയോയോ ഈ TV-യിൽ കാണിക്കാനാകില്ല. നിങ്ങളുടെ iPhone-ൽ മറ്റൊന്ന് പരീക്ഷിക്കുക."]},
    ar: {"ready": ["جاهز للبث", "على iPhone، افتح Screen Mirror واضغط على «⁨Cast to TV⁩»."], "connected": ["متصل", "جارٍ بدء البث…"], "stopped": ["توقف البث", "اضغط على «⁨Cast to TV⁩» في iPhone للبدء من جديد."], "lost": ["انقطع الاتصال", "تأكد من أن iPhone والتلفزيون على شبكة Wi‑Fi نفسها، ثم اضغط على «⁨Cast to TV⁩» مرة أخرى."], "reconnecting": ["جارٍ إعادة الاتصال…", "أبقِ Screen Mirror مفتوحًا على iPhone."], "waitingForStart": ["جاهز للبث", "تم توصيل iPhone. اضغط على «⁨Start Casting⁩» في التطبيق."], "stalledLost": ["في انتظار iPhone", "تأكد من أن iPhone قيد التشغيل ومتصل بشبكة Wi‑Fi نفسها التي يتصل بها هذا التلفزيون. إذا لم تعد الصورة، فاضغط على «⁨Cast to TV⁩» مرة أخرى."], "unreachable": ["تعذر الوصول إلى iPhone", "يجب أن يكون iPhone والتلفزيون على شبكة Wi‑Fi نفسها. غالبًا ما تحظر شبكات الضيوف والمكاتب ذلك."], "steps": ["وصّل iPhone بشبكة Wi‑Fi نفسها التي يتصل بها هذا التلفزيون", "افتح Screen Mirror على iPhone", "اضغط على «⁨Cast to TV⁩»"], "chip": "iPhone متصل", "badgeStall": "جارٍ إعادة الاتصال…", "badgePaused": "متوقف مؤقتًا على iPhone", "mediaError": ["تعذر التشغيل", "لا يمكن عرض هذه الصورة أو هذا الفيديو على هذا التلفزيون. جرّب عنصرًا آخر على iPhone."]},
    ur: {"ready": ["کاسٹ کے لیے تیار", "اپنے iPhone پر Screen Mirror کھولیں اور «⁨Cast to TV⁩» پر ٹیپ کریں۔"], "connected": ["منسلک ہو گیا", "کاسٹ شروع ہو رہی ہے…"], "stopped": ["کاسٹنگ رک گئی", "دوبارہ شروع کرنے کے لیے اپنے iPhone پر «⁨Cast to TV⁩» پر ٹیپ کریں۔"], "lost": ["کنکشن ٹوٹ گیا", "یقینی بنائیں کہ آپ کا iPhone اور TV ایک ہی Wi‑Fi پر ہیں، پھر دوبارہ «⁨Cast to TV⁩» پر ٹیپ کریں۔"], "reconnecting": ["دوبارہ منسلک ہو رہا ہے…", "اپنے iPhone پر Screen Mirror کھلا رکھیں۔"], "waitingForStart": ["کاسٹ کے لیے تیار", "آپ کا iPhone منسلک ہے۔ ایپ میں «⁨Start Casting⁩» پر ٹیپ کریں۔"], "stalledLost": ["آپ کے iPhone کا انتظار ہے", "یقینی بنائیں کہ آپ کا iPhone آن ہے اور اسی Wi‑Fi پر ہے جس پر یہ TV ہے۔ اگر تصویر واپس نہ آئے تو دوبارہ «⁨Cast to TV⁩» پر ٹیپ کریں۔"], "unreachable": ["آپ کے iPhone تک رسائی نہیں ہو سکی", "آپ کے iPhone اور TV کا ایک ہی Wi‑Fi پر ہونا ضروری ہے۔ مہمان اور دفتری نیٹ ورک اکثر اسے روک دیتے ہیں۔"], "steps": ["اپنے iPhone کو اسی Wi‑Fi سے جوڑیں جس پر یہ TV ہے", "اپنے iPhone پر Screen Mirror کھولیں", "«⁨Cast to TV⁩» پر ٹیپ کریں"], "chip": "iPhone منسلک ہے", "badgeStall": "دوبارہ منسلک ہو رہا ہے…", "badgePaused": "iPhone پر روکا گیا", "mediaError": ["یہ چلایا نہیں جا سکتا", "یہ تصویر یا ویڈیو اس TV پر نہیں دکھائی جا سکتی۔ اپنے iPhone پر کوئی اور آزمائیں۔"]},
    he: {"ready": ["מוכן להעברה", "ב-iPhone, פתחו את Screen Mirror והקישו על «⁨Cast to TV⁩»."], "connected": ["מחובר", "מתחילים להעביר…"], "stopped": ["ההעברה הופסקה", "הקישו על «⁨Cast to TV⁩» ב-iPhone כדי להתחיל שוב."], "lost": ["החיבור אבד", "ודאו שה-iPhone והטלוויזיה מחוברים לאותה רשת Wi‑Fi, ואז הקישו שוב על «⁨Cast to TV⁩»."], "reconnecting": ["מתחבר מחדש…", "השאירו את Screen Mirror פתוחה ב-iPhone."], "waitingForStart": ["מוכן להעברה", "ה-iPhone מחובר. הקישו על «⁨Start Casting⁩» באפליקציה."], "stalledLost": ["ממתין ל-iPhone", "ודאו שה-iPhone פועל ומחובר לאותה רשת Wi‑Fi כמו הטלוויזיה הזו. אם התמונה לא חוזרת, הקישו שוב על «⁨Cast to TV⁩»."], "unreachable": ["אין גישה ל-iPhone", "ה-iPhone והטלוויזיה צריכים להיות באותה רשת Wi‑Fi. רשתות אורחים ורשתות משרדיות חוסמות זאת לעיתים קרובות."], "steps": ["חברו את ה-iPhone לאותה רשת Wi‑Fi כמו הטלוויזיה הזו", "פתחו את Screen Mirror ב-iPhone", "הקישו על «⁨Cast to TV⁩»"], "chip": "ה-iPhone מחובר", "badgeStall": "מתחבר מחדש…", "badgePaused": "מושהה ב-iPhone", "mediaError": ["לא ניתן להפעיל", "לא ניתן להציג את התמונה או הסרטון האלה בטלוויזיה הזו. נסו פריט אחר ב-iPhone."]}
  });
  // Picks the TV's language: ?lang= (design preview) first, then the device
  // languages in order; anything unsupported falls back to English.
  const SCREEN_RTL_LANGUAGES = Object.freeze(["ar", "ur", "he"]);
  function resolveScreenLanguage(preferred) {
    for (const value of preferred || []) {
      if (typeof value !== "string") continue;
      const tag = value.trim().toLowerCase().replace(/_/g, "-");
      const base = tag.split("-")[0];
      if (base === "en") return "en";
      // Chinese: Traditional for Taiwan, Hong Kong and Macau or an explicit
      // Hant script; Simplified otherwise.
      if (base === "zh") return /(^|-)(hant|tw|hk|mo)(-|$)/.test(tag) ? "zh-hant" : "zh";
      if (base === "no" || base === "nn") return "nb";
      if (base === "tl") return "fil";
      if (base === "iw") return "he";
      if (Object.prototype.hasOwnProperty.call(SCREEN_TRANSLATIONS, base)) return base;
    }
    return "en";
  }
  function deviceLanguages() {
    const list = [];
    try {
      const forced = new URLSearchParams(global.location && global.location.search).get("lang");
      if (forced) list.push(forced);
    } catch (_) {}
    try {
      const nav = global.navigator;
      if (nav && Array.isArray(nav.languages)) list.push(...nav.languages);
      if (nav && typeof nav.language === "string") list.push(nav.language);
    } catch (_) {}
    return list;
  }
  let screenLanguage = "en";
  function screenText(key) {
    const local = screenLanguage !== "en" ? SCREEN_TRANSLATIONS[screenLanguage] : null;
    if (local && local[key] !== undefined) return local[key];
    return SCREEN_COPY[key] || SCREEN_EXTRA_COPY_EN[key];
  }
  // Static texts (chip, steps, badge) are in the page; replace them once.
  function applyScreenLanguage() {
    if (screenLanguage === "en") return;
    try {
      document.documentElement.lang = screenLanguage;
      // Arabic, Urdu and Hebrew read right to left.
      if (SCREEN_RTL_LANGUAGES.includes(screenLanguage)) document.documentElement.dir = "rtl";
      const chip = document.getElementById("phone-chip-text");
      if (chip) chip.textContent = screenText("chip");
      const steps = screenText("steps");
      for (let index = 0; index < steps.length; index += 1) {
        const step = document.getElementById(`status-step-${index + 1}`);
        if (step) step.textContent = steps[index];
      }
    } catch (_) {}
  }
  // Small "iPhone connected" chip and the how-to steps, per screen.
  const SCREEN_SHOWS_PHONE_CHIP = Object.freeze(["connected", "waitingForStart", "reconnecting"]);
  const SCREEN_SHOWS_STEPS = Object.freeze(["ready", "unreachable"]);
  // Calm-stall timings (2026-11-25): a short hiccup keeps the last picture
  // with a small corner badge; the full panel appears only if it persists.
  const STALL_FULL_SCREEN_AFTER_MS = 6000;
  const STALL_GIVE_UP_AFTER_MS = 30000;
  const CONNECTED_WITHOUT_START_MS = 20000;
  const NO_SENDER_RETURN_TO_HOME_MS = 90000;
  // Only "stopped" and "lost" count as genuinely idle for the return-to-home
  // timer — "ready" is first launch (still mid-setup) and "reconnecting" is
  // an in-progress recovery, neither of which should be cut short.
  // "stalledLost" is deliberately excluded: the iPhone is still connected
  // (e.g. locked), so the TV must not close the app underneath it.
  const IDLE_RETURN_TO_HOME_STATES = Object.freeze(["stopped", "lost", "unreachable"]);
  let currentScreen = "ready";
  let connectedWithoutStartTimer = null;
  let noSenderTimer = null;
  function clearConnectedWithoutStartTimer() {
    if (connectedWithoutStartTimer !== null) { global.clearTimeout(connectedWithoutStartTimer); connectedWithoutStartTimer = null; }
  }
  // One corner badge over the frozen picture: "Reconnecting…" for a stall,
  // "Paused on your iPhone" while iOS has paused screen sharing.
  let badgeKind = null;
  function setBadge(kind) {
    badgeKind = kind;
    try {
      const badge = document.getElementById("stall-badge");
      const text = document.getElementById("stall-badge-text");
      if (!badge) return;
      badge.hidden = !kind;
      badge.classList.toggle("paused", kind === "paused");
      if (text && kind) text.textContent = screenText(kind === "paused" ? "badgePaused" : "badgeStall");
    } catch (_) {}
  }
  function setStallBadge(visible) {
    if (visible) { if (badgeKind !== "paused") setBadge("stall"); }
    else if (badgeKind === "stall") setBadge(null);
  }
  // Features this TV app offers the iPhone on the media connection. Older
  // iPhone apps ignore the extra key; newer ones only send the matching
  // messages after seeing it, so neither side ever gets an unknown message.
  const MEDIA_FEATURES = Object.freeze(["senderPause", "mediaVisibility", "mediaReconnect"]);
  // Wi-Fi grace: after a short network drop the TV keeps the last picture and
  // reconnects to the same iPhone address for up to this long. Only used when
  // the iPhone opted in (senderFeatures "reconnect"); older iPhones end the
  // cast on a drop, so the TV must not wait for them.
  const MEDIA_RECONNECT_GRACE_MS = 8000;
  const MEDIA_RECONNECT_RETRY_MS = 1000;
  // While the picture is stuck, a small negotiated message every few seconds
  // makes a dead connection fail fast (instead of hanging silently), so the
  // reconnect starts while the iPhone is still waiting for it (it waits 15 s).
  const MEDIA_LIVENESS_PROBE_MS = 3000;
  // A recovery seek that has not finished after this long is released.
  const RECOVERY_SEEK_WATCHDOG_MS = 4000;
  // Media connections whose iPhone opted in to visibility reports (it sends
  // senderFeatures only after seeing "mediaVisibility" above).
  const mediaVisibilityListeners = new Set();
  function notifyMediaVisibility(visibility) {
    for (const send of mediaVisibilityListeners) { try { send(visibility); } catch (_) {} }
  }
  // No phone connected while idle: return the TV to its home screen instead of
  // keeping the receiver alive (and possibly hidden behind another TV app).
  function cancelNoSenderTimer() {
    if (noSenderTimer !== null) { global.clearTimeout(noSenderTimer); noSenderTimer = null; }
  }
  function scheduleNoSenderReturnToHome() {
    cancelNoSenderTimer();
    noSenderTimer = global.setTimeout(() => {
      noSenderTimer = null;
      let senders = 1;
      try { senders = context && typeof context.getSenders === "function" ? context.getSenders().length : 1; } catch (_) {}
      if (senders === 0 && currentScreen !== "playing") {
        // A video still playing with no phone may finish first; a photo or an
        // ended video with no phone returns the TV to its home screen.
        if (playerActive && ["PLAYING", "BUFFERING"].includes(playerState())) { scheduleNoSenderReturnToHome(); return; }
        try { if (context && typeof context.stop === "function") context.stop(); } catch (_) {}
      }
    }, NO_SENDER_RETURN_TO_HOME_MS);
  }
  let idleReturnToHomeTimer = null;
  function cancelIdleReturnToHomeTimer() {
    if (idleReturnToHomeTimer === null) return;
    global.clearTimeout(idleReturnToHomeTimer);
    idleReturnToHomeTimer = null;
  }
  function scheduleIdleReturnToHomeTimer() {
    cancelIdleReturnToHomeTimer();
    idleReturnToHomeTimer = global.setTimeout(() => {
      idleReturnToHomeTimer = null;
      try {
        if (context && typeof context.stop === "function") context.stop();
      } catch (_) {}
    }, IDLE_RETURN_TO_HOME_MS);
  }
  // Photos, videos and video links (Gallery, Cast Video, Cast Playlist) play
  // inside this TV app with the Cast framework's standard player — the same
  // LOAD messages the iPhone sends to Google's generic player today. Mirroring
  // is a separate path; the two never run at once (starting one stops the other).
  let playerManager = null;
  let playerActive = false;
  let stopMirroringForPlayer = null;
  function setPlayerActive(active, screenAfter) {
    if (playerActive === active) return;
    playerActive = active;
    try { document.body.classList.toggle("player-active", active); } catch (_) {}
    if (active) {
      clearConnectedWithoutStartTimer(); cancelNoSenderTimer(); cancelIdleReturnToHomeTimer();
      setBadge(null);
      currentScreen = "player";
      receiverReadinessState = receiverReadinessStateForScreen("player");
      if (ui) ui.panel.hidden = true;
    } else {
      showScreen(screenAfter || "ready");
    }
  }
  function playerState() {
    try { return playerManager && typeof playerManager.getPlayerState === "function" ? playerManager.getPlayerState() : null; }
    catch (_) { return null; }
  }
  function stopPlayerForMirroring() {
    if (!playerActive) return;
    try { if (playerManager && typeof playerManager.stop === "function") playerManager.stop(); } catch (_) {}
    setPlayerActive(false, "connected");
  }
  function publishMediaDuration(manager) {
    const info = manager && typeof manager.getMediaInformation === "function" ? manager.getMediaInformation() : null;
    const duration = manager && typeof manager.getDurationSec === "function" ? manager.getDurationSec() : NaN;
    if (!info || (info.duration > 0) || !(Number.isFinite(duration) && duration > 0)) return false;
    info.duration = duration;
    if (typeof manager.setMediaInformation === "function") manager.setMediaInformation(info, true);
    return true;
  }
  function installMediaPlayer(framework) {
    if (!context || typeof context.getPlayerManager !== "function" || !framework || !framework.messages || !framework.events) return;
    try {
      playerManager = context.getPlayerManager();
      if (!playerManager) return;
      playerManager.setMessageInterceptor(framework.messages.MessageType.LOAD, (request) => {
        // A cast is running: end it first, exactly as Google's player did
        // when it replaced this app on the TV.
        if (typeof stopMirroringForPlayer === "function") { try { stopMirroringForPlayer(); } catch (_) {} }
        // Owner 2026-11-25: no "Gallery Video" title or subtitle over the picture.
        try { if (request && request.media && request.media.metadata) request.media.metadata = null; } catch (_) {}
        setPlayerActive(true);
        return request;
      });
      const events = framework.events.EventType;
      // Report the video length so the iPhone can show its scrubber.
      if (events.PLAYER_LOAD_COMPLETE) playerManager.addEventListener(events.PLAYER_LOAD_COMPLETE, () => {
        try { publishMediaDuration(playerManager); } catch (_) {}
      });
      playerManager.addEventListener(events.ERROR, (errorEvent) => {
        if (!playerActive) return;
        // A slideshow sends the next item while the previous one may still be
        // loading: that interruption is not a failure.
        const codes = framework.events.DetailedErrorCode || {};
        const code = errorEvent && errorEvent.detailedErrorCode;
        if (code !== undefined && codes.LOAD_INTERRUPTED !== undefined && code === codes.LOAD_INTERRUPTED) return;
        // Non-fatal errors leave the player running; only a stopped player is a failure.
        const state = playerState();
        if (state && state !== "IDLE") return;
        setPlayerActive(false, "mediaError");
      });
      // Stop from the iPhone (or the TV remote): back to the ready screen.
      playerManager.addEventListener(events.REQUEST_STOP, () => {
        if (playerActive) setPlayerActive(false, "ready");
      });
    } catch (_) { playerManager = null; }
  }
  function showScreen(state) {
    currentScreen = state;
    if (state !== "connected") clearConnectedWithoutStartTimer();
    if (state === "playing" || state === "stopped" || state === "lost" || state === "stalledLost") setStallBadge(false);
    receiverReadinessState = receiverReadinessStateForScreen(state);
    if (IDLE_RETURN_TO_HOME_STATES.includes(state)) scheduleIdleReturnToHomeTimer();
    else cancelIdleReturnToHomeTimer();
    if (!ui) return;
    const copy = SCREEN_COPY[state] ? screenText(state) : null;
    ui.panel.hidden = state === "playing";
    document.body.classList.remove("receiver-waiting");
    if (state === "ready" || state === "reconnecting") document.body.classList.add("receiver-waiting");
    if (copy) { ui.title.textContent = copy[0]; ui.detail.textContent = copy[1]; }
    try {
      if (ui.chip) ui.chip.hidden = !SCREEN_SHOWS_PHONE_CHIP.includes(state);
      if (ui.steps) ui.steps.hidden = !SCREEN_SHOWS_STEPS.includes(state);
      // Restart the soft fade so screen changes never flash.
      if (ui.content && ui.content.classList) {
        ui.content.classList.remove("screen-enter");
        void ui.content.offsetWidth;
        ui.content.classList.add("screen-enter");
      }
    } catch (_) {}
  }
  function closeScreen(event, failed) {
    return !failed && event && event.code === 1000 && event.wasClean === true ? "stopped" : "lost";
  }
  function parse(data) {
    try {
      const raw = typeof data === "string" ? data : JSON.stringify(data);
      if (!raw || byteLength(raw) > MAX_MESSAGE_BYTES) return null;
      const object = JSON.parse(raw);
      return safeObject(object) ? object : null;
    } catch (_) { return null; }
  }
  function makeResult(requestId, result) {
    return { type: "probeResult", protocolVersion: PROTOCOL_VERSION, requestId, receiverVersion: RECEIVER_VERSION, result, capabilities: { ...capabilities } };
  }
  function validEndpoint(value) {
    try {
      const url = new URL(value);
      return url.protocol === "ws:" && !!url.hostname && !!url.port && /^\/[A-Za-z0-9]{64}$/.test(url.pathname);
    } catch (_) { return false; }
  }
  function validateProbe(data) {
    const message = parse(data);
    if (!message || Object.keys(message).length !== 4 || message.type !== "probeEndpoint" ||
        message.protocolVersion !== PROTOCOL_VERSION || typeof message.requestId !== "string" ||
        !REQUEST_ID.test(message.requestId) || typeof message.endpoint !== "string" || !validEndpoint(message.endpoint)) return null;
    return message;
  }
  function validateReadyQuery(data) {
    const message = parse(data);
    if (!message || Object.keys(message).length !== 3 || message.type !== "receiverReadyQuery" ||
        message.protocolVersion !== PROTOCOL_VERSION || typeof message.requestId !== "string" ||
        !REQUEST_ID.test(message.requestId)) return null;
    return message;
  }
  function makeReadyReport(requestId, receiverState = receiverReadinessState, audioSupported = false) {
    const report = { type: "receiverReadyReport", protocolVersion: PROTOCOL_VERSION, requestId,
      receiverVersion: RECEIVER_VERSION, receiverRevision: RECEIVER_REVISION, receiverState };
    if (audioSupported) report.audioCapabilities = ["aac_lc_cmaf"];
    return report;
  }
  // Visibility (opt-in, 2026-11-24). A receiver kept running behind another
  // TV app (e.g. YouTube) still answers Ready and accepts media while nothing
  // is visible. Senders that understand this ask with a separate query and
  // are then told about changes; older senders never ask and never receive
  // these messages, so the existing Ready report is unchanged.
  function validateVisibilityQuery(data) {
    const message = parse(data);
    if (!message || Object.keys(message).length !== 3 || message.type !== "receiverVisibilityQuery" ||
        message.protocolVersion !== PROTOCOL_VERSION || typeof message.requestId !== "string" ||
        !REQUEST_ID.test(message.requestId)) return null;
    return message;
  }
  function resolveVisibility(documentState, cafVisibility, cafStandby) {
    if (documentState === "hidden" || cafVisibility === "NOT_VISIBLE" || cafStandby === "STANDBY") return "hidden";
    if (documentState === "visible" || cafVisibility === "VISIBLE") return "visible";
    return "unknown";
  }
  // Media capability (opt-in, 2026-11-25). Phones that ask learn whether this
  // TV plays iPhone (HEVC) video directly, so they can skip re-encoding it.
  // Older phones never ask; older TV apps ignore the question.
  function validateMediaCapabilityQuery(data) {
    const message = parse(data);
    if (!message || Object.keys(message).length !== 3 || message.type !== "receiverMediaCapabilityQuery" ||
        message.protocolVersion !== PROTOCOL_VERSION || typeof message.requestId !== "string" ||
        !REQUEST_ID.test(message.requestId)) return null;
    return message;
  }
  // HEVC strings: Main (8-bit SDR), Main 10 (HDR), and 4K at level 5.1.
  const HEVC_PROBES = Object.freeze({
    hevc: ["video/mp4", "hvc1.1.6.L120.90", 1920, 1080, 30],
    hevcHDR: ["video/mp4", "hvc1.2.4.L120.90", 1920, 1080, 30],
    hevc4K: ["video/mp4", "hvc1.1.6.L153.90", 3840, 2160, 30]
  });
  function mediaCapabilities(canDisplay) {
    const check = (args) => { try { return canDisplay(...args) === true; } catch (_) { return false; } };
    const hevc = check(HEVC_PROBES.hevc);
    return { hevc, hevcHDR: hevc && check(HEVC_PROBES.hevcHDR), hevc4K: hevc && check(HEVC_PROBES.hevc4K) };
  }
  function makeMediaCapabilityReport(requestId, video) {
    return { type: "receiverMediaCapabilityReport", protocolVersion: PROTOCOL_VERSION, requestId, video };
  }
  function makeVisibilityReport(requestId, visibility) {
    return { type: "receiverVisibilityReport", protocolVersion: PROTOCOL_VERSION, requestId, visibility };
  }
  function capabilityResult() {
    return capabilities.webSocketAPI && capabilities.mediaSource && capabilities.avcMIME && capabilities.sourceBuffer;
  }
  function safeException(error) {
    if (!error) return "none";
    const name = typeof error.name === "string" ? error.name : "error";
    const message = typeof error.message === "string" ? error.message : "";
    return `${name}_${message}`.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 64) || "error";
  }
  function safeMediaSourceState(source) {
    try { return source && ["closed", "open", "ended"].includes(source.readyState) ? source.readyState : "unknown"; }
    catch (_) { return "unknown"; }
  }
  function capabilityDiagnosticResults() {
    const bool = (value) => value ? "true" : "false";
    const openDelay = capabilityProbeTrace.sourceOpenDelayMs < 0 ? "na" : capabilityProbeTrace.sourceOpenDelayMs;
    const results = [
      `receiver_capability_websocket_${bool(capabilities.webSocketAPI)}_mediasource_${bool(capabilities.mediaSource)}_avcmime_${bool(capabilities.avcMIME)}_sourcebuffer_${bool(capabilities.sourceBuffer)}`,
      "receiver_capability_probe_protocol_2_mime_avc1_42e01f",
      `receiver_capability_avcmime_outcome_${capabilityProbe.avcMIMEOutcome}_exception_${capabilityProbe.avcMIMEException}`,
      `receiver_capability_sourcebuffer_outcome_${capabilityProbe.sourceBufferOutcome}_exception_${capabilityProbe.sourceBufferException}`
    ];
    if (capabilityProbeTrace.settled !== "not_started") results.push(
      `receiver_capability_probe_settled_${capabilityProbeTrace.settled}_sourceopen_${capabilityProbeTrace.sourceOpen}`,
      `receiver_capability_probe_addbuffer_${capabilityProbeTrace.addSourceBuffer}_open_delay_ms_${openDelay}`,
      `receiver_capability_probe_source_state_timeout_${capabilityProbeTrace.sourceStateAtTimeout}_at_media_${safeMediaSourceState(capabilityProbeTrace.source)}`
    );
    results.push("receiver_capability_revision_corr_fragseq_20260922_capability_snapshot");
    return results;
  }
  function sendCapabilityDiagnostics(event, request) {
    for (const result of capabilityDiagnosticResults()) sendMediaResult(event.senderId, request.requestId, result);
  }
  function recoverySeekTarget(currentTime, start, end) {
    if (!Number.isFinite(currentTime) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    const inset = Math.min(0.05, Math.max(0, (end - start) / 2));
    if (currentTime < start) return start + inset;
    if (currentTime > end) return end - inset;
    return null;
  }
  function stalledLiveEdgeSeekTarget(currentTime, start, end) {
    if (!Number.isFinite(currentTime) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - currentTime < 0.05) return null;
    const target = Math.max(start + 0.05, end - 0.05);
    return target > currentTime + 0.02 ? target : null;
  }
  function bufferedTrimEnd(currentTime, start, end) {
    if (!Number.isFinite(currentTime) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    if (currentTime - start <= TRIM_HISTORY_THRESHOLD_SECONDS || end - currentTime < 0.5) return null;
    return Math.max(0, currentTime - RETAINED_HISTORY_SECONDS);
  }
  function liveEdgePlaybackRate(lead, currentRate) {
    if (!Number.isFinite(lead) || !Number.isFinite(currentRate)) return null;
    if (lead >= LIVE_EDGE_FAST_THRESHOLD_SECONDS) return LIVE_EDGE_FAST_PLAYBACK_RATE;
    if (currentRate > 1 && lead <= LIVE_EDGE_NORMAL_THRESHOLD_SECONDS) return 1;
    return null;
  }
  function readBufferedRanges(ranges) {
    const result = [];
    try {
      for (let i = 0; ranges && i < Math.min(ranges.length, 8); i += 1) {
        const start = ranges.start(i); const end = ranges.end(i);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
        result.push({ start, end });
      }
    } catch (_) { return []; }
    return result;
  }
  function containingRange(ranges, position) {
    if (!Number.isFinite(position)) return null;
    return ranges.find((range) => range.start <= position && position < range.end) || null;
  }
  // An appended sync sample, rather than an arbitrary buffered time, is the
  // only eligible healthy catch-up destination. The same media element seeks
  // both tracks; AAC additionally requires one continuous common range.
  function createHealthyLiveEdgeCatchup(runID) {
    let highSince = null; let lastSeekAt = -Infinity; let armed = true; let seekPending = false; let closed = false;
    return {
      consider(sample) {
        if (closed || sample.runID !== runID) return null;
        const now = sample.nowMs;
        const videoRange = containingRange(sample.videoRanges || [], sample.currentTime);
        const audioRange = sample.audioRequested ? containingRange(sample.audioRanges || [], sample.currentTime) : null;
        const healthy = Number.isFinite(now) && videoRange && sample.readyState >= 3 && !sample.paused
          && !sample.ended && !sample.seeking && !sample.mediaError && sample.sourceOpen
          && !sample.videoUpdating && sample.pendingDepth <= 1 && sample.progressAgeMs <= 750
          && sample.appendAgeMs <= 1000 && (sample.renderAgeMs === null || sample.renderAgeMs <= 750)
          && (!sample.audioRequested || (sample.audioReady && audioRange && !sample.audioUpdating));
        if (!healthy) { highSince = null; return null; }
        const end = sample.audioRequested ? Math.min(videoRange.end, audioRange.end) : videoRange.end;
        const lead = end - sample.currentTime;
        if (lead <= HEALTHY_CATCHUP_REARM_SECONDS && !seekPending) armed = true;
        if (lead < HEALTHY_CATCHUP_TRIGGER_SECONDS || !armed || seekPending) { highSince = null; return null; }
        if (highSince === null) highSince = now;
        if (now - highSince < HEALTHY_CATCHUP_PERSIST_MS || now - lastSeekAt < HEALTHY_CATCHUP_COOLDOWN_MS) return null;
        const latest = end - HEALTHY_CATCHUP_MARGIN_SECONDS;
        const candidates = (sample.syncPoints || []).filter((point) => Number.isFinite(point)
          && point >= videoRange.start && point < videoRange.end
          && (!sample.audioRequested || (point >= audioRange.start && point < audioRange.end))
          && point <= latest && point - sample.currentTime >= HEALTHY_CATCHUP_MIN_JUMP_SECONDS);
        const sync = candidates[candidates.length - 1];
        if (sync === undefined) return null;
        highSince = null; armed = false; seekPending = true; lastSeekAt = now;
        return sync;
      },
      completeSeek(run) { if (!closed && run === runID) seekPending = false; },
      close() { closed = true; highSince = null; seekPending = false; }
    };
  }
  function makeLatencyStage(generation, sequence, stage, receiverTimeMs, bufferLeadMs, pendingDepth) {
    if (!Number.isInteger(generation) || generation <= 0 || !Number.isInteger(sequence) || sequence <= 0 ||
        !["received", "append_started", "append_ended"].includes(stage) || !Number.isFinite(receiverTimeMs) || receiverTimeMs < 0 ||
        !Number.isFinite(bufferLeadMs) || bufferLeadMs < 0 || !Number.isInteger(pendingDepth) || pendingDepth < 0 || pendingDepth > 8) return null;
    return { type: "latencyStage", generation, sequence, stage, receiverTimeMs, bufferLeadMs, pendingDepth };
  }
  function makePeriodicPlaybackSample(video, buffer, metrics) {
    const boundedMs = (seconds) => Number.isFinite(seconds) && seconds >= 0 ? Math.min(3600000, Math.round(seconds * 1000)) : -1;
    const endMs = (ranges) => {
      try { return ranges && ranges.length ? boundedMs(ranges.end(ranges.length - 1)) : -1; }
      catch (_) { return -1; }
    };
    let quality;
    try { quality = typeof video.getVideoPlaybackQuality === "function" ? video.getVideoPlaybackQuality() : null; } catch (_) { quality = null; }
    const count = (value) => Number.isFinite(value) && value >= 0 ? Math.min(1000000, Math.floor(value)) : -1;
    const currentTimeMs = boundedMs(video.currentTime);
    const sourceEndMs = endMs(buffer && buffer.buffered);
    return {
      type: "stats", protocolVersion: PROTOCOL_VERSION, generation: metrics.generation,
      sampleIndex: metrics.sampleIndex, receiverTimeMs: Math.max(0, Math.round(metrics.nowMs)),
      currentTimeMs, bufferedEndMs: endMs(video.buffered), sourceEndMs,
      liveEdgeMs: sourceEndMs < 0 || currentTimeMs < 0 ? -1 : Math.max(-60000, Math.min(60000, sourceEndMs - currentTimeMs)),
      readyState: Math.max(0, Math.min(4, video.readyState || 0)), paused: !!video.paused,
      playbackRateMilli: Math.max(0, Math.min(4000, Math.round((video.playbackRate || 0) * 1000))),
      sourceUpdating: !!(buffer && buffer.updating), queueDepth: Math.max(0, Math.min(8, metrics.queueDepth)),
      receiverDrops: count(metrics.receiverDrops), appendedFragments: count(metrics.appendedFragments),
      renderedCallbacks: count(metrics.renderedCallbacks), presentedFrames: count(metrics.presentedFrames),
      totalVideoFrames: count(quality && quality.totalVideoFrames), droppedFrames: count(quality && quality.droppedVideoFrames),
      uncorrelatedFrames: count(metrics.uncorrelatedFrames),
      lastAppendAgeMs: metrics.lastAppendAtMs === null ? -1 : Math.max(0, Math.min(60000, Math.round(metrics.nowMs - metrics.lastAppendAtMs))),
      lastRenderAgeMs: metrics.lastRenderAtMs === null ? -1 : Math.max(0, Math.min(60000, Math.round(metrics.nowMs - metrics.lastRenderAtMs))),
      renderedMediaTimeMs: boundedMs(metrics.renderedMediaTime),
      decodeDurationMs: Math.min(60000, boundedMs(metrics.decodeDuration)),
      displayLeadMs: Math.min(60000, boundedMs(metrics.displayLead)),
      seekCount: count(metrics.seekCount), lastSeekKind: metrics.lastSeekKind,
      rateChanges: count(metrics.rateChanges)
    };
  }
  function canConfirmFirstRendered(firstRendered, firstMediaAppended, metadata) {
    return !firstRendered && firstMediaAppended && Number.isFinite(metadata && metadata.presentedFrames) && metadata.presentedFrames > 0;
  }
  // Presentation-only gate. `waiting` is commonly emitted around a normal MSE
  // append; it must not replace visible video with the casting screen unless
  // playback has genuinely stopped advancing for the existing stall interval.
  function shouldShowReconnectingScreen(firstRendered, receiverStopped, playbackAdvancedAt, now, stallThresholdMs) {
    return !!firstRendered && !receiverStopped && Number.isFinite(playbackAdvancedAt) && Number.isFinite(now) && Number.isFinite(stallThresholdMs) && now - playbackAdvancedAt >= stallThresholdMs;
  }
  // Diagnostics 31: a picture that stops moving is not a lost phone. ReplayKit
  // sends no new frames while the iPhone screen does not change, so the video
  // freezes while the phone keeps sending sound and control messages. Only a
  // phone that has also gone completely quiet for the give-up time is gone.
  function stallEndsAsConnectionLost(senderReconnect, lastSenderMessageAt, now) {
    return senderReconnect === true && Number.isFinite(lastSenderMessageAt) && Number.isFinite(now)
      && now - lastSenderMessageAt >= STALL_GIVE_UP_AFTER_MS;
  }
  function renderedCorrelationStrategy(hasExactMatch, hasOrderedMatch) {
    if (hasExactMatch) return "media_time";
    if (hasOrderedMatch) return "append_order";
    return "unavailable";
  }
  // Diagnostic state only: no media payloads, credits, or queue ownership.
  function createFrameCorrelationTracker(generation, diagnostic, stage, rendered) {
    const fragments = []; const controls = new Map(); const callbacks = [];
    const maxFragments = 64; const maxCallbacks = 256; const ttlMs = 10000; const mediaToleranceSeconds = 0.5;
    const counts = {}; let closed = false;
    const emit = (reason) => { counts[reason] = (counts[reason] || 0) + 1; if (counts[reason] <= 8) diagnostic(reason); };
    let comparisonDiagnostics = 0;
    const fail = () => emit("rendered_frame_uncorrelated_no_fragment_match");
    const nearestFragment = (mediaTime, candidates) => candidates.reduce((best, item) => {
      const delta = Math.abs(item.mediaTime - mediaTime);
      return !best || delta < best.delta ? { item, delta } : best;
    }, null);
    const emitComparison = (prefix, control, candidate, retained) => {
      if (comparisonDiagnostics >= 8) return;
      comparisonDiagnostics += 1;
      const nearest = candidate ? candidate.item : null;
      diagnostic(`${prefix}_controlSeq_${Number.isInteger(control.sequence) ? control.sequence : "na"}_controlFragmentSeq_${Number.isInteger(control.fragmentSequence) ? control.fragmentSequence : "na"}_controlMediaMs_${Math.round(control.mediaTime * 1000)}_controlCapturePTS90k_${Number.isInteger(control.capturePTS90k) ? control.capturePTS90k : "na"}_controlCaptureDelta90k_${Number.isInteger(control.captureDelta90k) ? control.captureDelta90k : "na"}_nearestFragmentSeq_${nearest ? nearest.id : "na"}_nearestMediaMs_${nearest ? Math.round(nearest.mediaTime * 1000) : "na"}_deltaMs_${candidate ? Math.round(candidate.delta * 1000) : "na"}_generationMatch_${control.generation === generation ? 1 : 0}_retained_${retained}_appended_${nearest && nearest.appendedAt !== undefined ? 1 : 0}`);
    };
    const expire = (now) => {
      while (fragments.length && (now - fragments[0].receivedAt >= ttlMs || fragments.length > maxFragments)) {
        const item = fragments.shift();
        if (!item.correlation) emit("frame_correlation_late_bind_expired");
      }
      for (const [key, item] of controls) if (now - item.at >= ttlMs) controls.delete(key);
      while (callbacks.length && (now - callbacks[0].now >= ttlMs || callbacks.length > maxCallbacks)) { callbacks.shift(); fail(); }
    };
    const bind = (item, control) => {
      item.correlation = control;
      controls.delete(control.sequence);
      if (item.appendedAt !== undefined) emit("frame_correlation_late_bound");
      for (const [name, at] of [["received", item.receivedAt], ["append_started", item.startedAt], ["append_ended", item.appendedAt]]) {
        if (at !== undefined) stage(name, control.sequence, at, item.metrics[name]);
      }
    };
    const match = (frame) => {
      const appended = fragments.filter((item) => item.appendedAt !== undefined && item.appendedAt <= frame.now);
      // Match the actual fragment's decode-time interval before using ordered fallback.
      const exact = appended.find((item, index) => item.correlation &&
        frame.metadata.mediaTime >= item.mediaTime - 0.001 &&
        frame.metadata.mediaTime < (appended[index + 1] ? appended[index + 1].mediaTime : item.mediaTime + mediaToleranceSeconds));
      let item = exact;
      if (item && item.sent) return true;
      if (!item) {
        const nearest = nearestFragment(frame.metadata.mediaTime, appended.filter((candidate) => candidate.correlation && !candidate.sent));
        if (nearest && nearest.delta <= mediaToleranceSeconds) item = nearest.item;
      }
      // If the callback's media time is outside the retained range, use the
      // oldest appended correlated fragment as the bounded ordered fallback.
      // This is valid only when an exact control binding already exists.
      const unresolvedOlderFragment = appended.some((candidate) => !candidate.correlation && !candidate.sent && candidate.mediaTime <= frame.metadata.mediaTime);
      if (!item && !unresolvedOlderFragment) {
        item = appended.find((candidate) => candidate.correlation && !candidate.sent);
      }
      if (!item && !unresolvedOlderFragment) emitComparison("frame_correlation_render_no_match", { generation, mediaTime: frame.metadata.mediaTime }, nearestFragment(frame.metadata.mediaTime, appended), fragments.length);
      if (!item || !item.correlation) return false;
      if (!item.sent) { item.sent = true; rendered(frame.now, frame.metadata, item.correlation); }
      return true;
    };
    const retry = () => { for (let i = 0; i < callbacks.length;) { if (match(callbacks[i])) callbacks.splice(i, 1); else i += 1; } };
    return {
      receive(id, mediaTime, now, metrics) {
        if (closed) return null;
        expire(now);
        const item = { id, mediaTime, receivedAt: now, metrics: { received: metrics } };
        fragments.push(item); expire(now);
        const controlByFragmentID = Array.from(controls.values()).find((control) => control.fragmentSequence === id) || controls.get(id);
        const candidate = controlByFragmentID
          ? { item: controlByFragmentID, delta: Math.abs(controlByFragmentID.mediaTime - mediaTime) }
          : nearestFragment(mediaTime, Array.from(controls.values()));
        const control = candidate && candidate.delta <= mediaToleranceSeconds ? candidate.item : null;
        if (controlByFragmentID || control) bind(item, controlByFragmentID || control);
        return item;
      },
      start(item, now, metrics) { if (!item || closed) return; item.startedAt = now; item.metrics.append_started = metrics; if (item.correlation) stage("append_started", item.correlation.sequence, now, metrics); },
      append(item, now, metrics) { if (!item || closed) return; item.appendedAt = now; item.metrics.append_ended = metrics; if (item.correlation) stage("append_ended", item.correlation.sequence, now, metrics); expire(now); retry(); },
      control(value, now) {
        if (closed || value.generation !== generation || value.sequence <= 0 || !Number.isFinite(value.mediaTimeMs)) return;
        expire(now);
        const control = { generation, sequence: value.sequence, fragmentSequence: Number.isInteger(value.fragmentSequence) ? value.fragmentSequence : null, mediaTime: value.mediaTimeMs / 1000, capturePTS90k: Number.isInteger(value.capturePTS90k) ? value.capturePTS90k : null, captureDelta90k: Number.isInteger(value.captureDelta90k) ? value.captureDelta90k : null, at: now };
        const fragmentByID = fragments.find((item) => !item.correlation && item.id === (control.fragmentSequence || control.sequence));
        const candidate = fragmentByID
          ? { item: fragmentByID, delta: Math.abs(fragmentByID.mediaTime - control.mediaTime) }
          : nearestFragment(control.mediaTime, fragments.filter((item) => !item.correlation));
        if (fragmentByID || (candidate && candidate.delta <= mediaToleranceSeconds)) { bind(fragmentByID || candidate.item, control); retry(); }
        else {
          if (!fragments.length) {
            controls.set(control.sequence, control); if (controls.size > maxFragments) controls.delete(controls.keys().next().value);
            return;
          }
          emitComparison("frame_correlation_control_no_match", control, nearestFragment(control.mediaTime, fragments), fragments.length);
          controls.set(control.sequence, control); if (controls.size > maxFragments) controls.delete(controls.keys().next().value);
        }
      },
      frame(now, metadata) { if (closed) return; expire(now); const frame = { now, metadata }; if (!match(frame)) { callbacks.push(frame); expire(now); } },
      finish(now) { if (closed) return; expire(now); retry(); while (callbacks.length) { callbacks.shift(); fail(); } closed = true; fragments.length = 0; controls.clear(); },
      snapshot: () => ({ fragments: fragments.length, controls: controls.size, callbacks: callbacks.length, counts: { ...counts } })
    };
  }
  function createFramePacingSummary(emit) {
    // Fixed histogram: full-session percentiles rounded up to 1 ms; >10 s is overflow.
    const cadence = () => ({ count: 0, first: null, last: null, max: 0, bursts: 0, histogram: new Uint32Array(10002) });
    const render = cadence(); const append = cadence();
    let firstPresented = null; let lastPresented = null; let presentedJumps = 0; let finished = false;
    const add = (value, now) => {
      if (value.last !== null) { const interval = Math.max(0, now - value.last); value.max = Math.max(value.max, interval); if (interval < 8) value.bursts += 1; value.histogram[Math.min(10001, Math.ceil(interval))] += 1; }
      if (value.first === null) value.first = now;
      value.last = now; value.count += 1;
    };
    const summarize = (value) => {
      const percentile = (fraction) => { const target = Math.ceil((value.count - 1) * fraction); if (target <= 0) return null; let count = 0; for (let i = 0; i < value.histogram.length; i += 1) { count += value.histogram[i]; if (count >= target) return i; } return null; };
      return { count: value.count, durationMs: value.count > 1 ? Math.round(value.last - value.first) : 0, p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: value.count > 1 ? Math.round(value.max) : null, burstUnder8Ms: value.bursts, intervalOverflow: value.histogram[10001] };
    };
    return {
      frame(now, metadata) {
        if (finished) return;
        add(render, now);
        if (Number.isFinite(metadata.presentedFrames)) { if (firstPresented === null) firstPresented = metadata.presentedFrames; if (lastPresented !== null && metadata.presentedFrames - lastPresented > 1) presentedJumps += 1; lastPresented = metadata.presentedFrames; }
      },
      append(now) { if (!finished) add(append, now); },
      stop(counts) {
        if (finished) return null;
        finished = true;
        const r = summarize(render); const a = summarize(append);
        const delta = firstPresented === null ? null : Math.max(0, lastPresented - firstPresented);
        const summary = { render: r, append: a, presentedFramesDelta: delta, presentedFPSMilli: delta !== null && r.durationMs > 0 ? Math.round(delta * 1000000 / r.durationMs) : null, presentedJumps, uncorrelated: counts.rendered_frame_uncorrelated_no_fragment_match || 0, lateBound: counts.frame_correlation_late_bound || 0, lateBindExpired: counts.frame_correlation_late_bind_expired || 0 };
        // Numeric, allowlisted category characters survive the existing iOS diagnostic exporter.
        const fields = (object) => Object.entries(object).map(([key, value]) => `${key}_${value === null ? "na" : value}`).join("_");
        emit(`frame_pacing_summary_render_${fields(r)}`);
        emit(`frame_pacing_summary_append_${fields(a)}`);
        emit(`frame_pacing_summary_presentedFramesDelta_${delta === null ? "na" : delta}_presentedFPSMilli_${summary.presentedFPSMilli === null ? "na" : summary.presentedFPSMilli}_presentedJumps_${presentedJumps}_uncorrelated_no_fragment_match_${summary.uncorrelated}_lateBound_${summary.lateBound}_lateBindExpired_${summary.lateBindExpired}`);
        return summary;
      }
    };
  }
  function send(senderId, requestId, result) {
    context.sendCustomMessage(NAMESPACE, senderId, makeResult(requestId, result));
  }
  function probeWebSocket(event) {
    const request = validateProbe(event.data);
    if (!event || !event.senderId || !request) { return; }
    capabilityReadyPromise.then(() => runWebSocketProbe(event.senderId, request));
  }
  function validateMediaStart(data) {
    const message = parse(data);
    const keys = message && Object.keys(message);
    if (!message || (keys.length !== 4 && keys.length !== 5) || message.type !== "startMedia" ||
        message.protocolVersion !== PROTOCOL_VERSION || typeof message.requestId !== "string" ||
        !REQUEST_ID.test(message.requestId) || typeof message.endpoint !== "string" || !validEndpoint(message.endpoint)) return null;
    if (keys.length === 5 && message.audioCodec !== "mp4a.40.2") return null;
    return message;
  }
  // A phone that leaves the app and comes back gets a new Cast sender address
  // (diagnostics 18/19: "Casting Stopped" went to the old one, so the phone
  // never heard it and disconnected). Keep the original while it is connected,
  // otherwise answer the most recently connected phone.
  function chooseReplySender(original, connectedIds, connectedAt) {
    if (!Array.isArray(connectedIds) || connectedIds.length === 0 || connectedIds.includes(original)) return original;
    let best = connectedIds[connectedIds.length - 1];
    let bestAt = -Infinity;
    for (const id of connectedIds) {
      const at = connectedAt && connectedAt.has(id) ? connectedAt.get(id) : -Infinity;
      if (at > bestAt) { best = id; bestAt = at; }
    }
    return best;
  }
  function currentReplySender(original) {
    let ids = null;
    try {
      const senders = typeof context.getSenders === "function" ? context.getSenders() : null;
      if (Array.isArray(senders)) ids = senders.map((sender) => sender && sender.id).filter((id) => typeof id === "string" && id);
    } catch (_) { ids = null; }
    return chooseReplySender(original, ids, senderConnections);
  }
  function sendMediaResult(senderId, requestId, result, telemetry, observedReceiverTime) {
    const payload = { type: "mediaResult", protocolVersion: PROTOCOL_VERSION, requestId, receiverVersion: RECEIVER_VERSION, result };
    if (["receiver_first_message_received", "receiver_auth_validation_passed", "receiver_media_ready_received"].includes(result)
        || result.startsWith("first_frame_callback_presented_") || result.startsWith("first_fragment_seq_")) {
      payload.receiverUptimeMs = performance.now();
    }
    if (Number.isFinite(observedReceiverTime)) payload.receiverUptimeMs = observedReceiverTime;
    if (telemetry) payload.telemetry = telemetry;
    context.sendCustomMessage(NAMESPACE, currentReplySender(senderId), payload);
  }
  function sendReceiverDiagnostic(event, request, result) {
    if (!event || !event.senderId || !request || typeof request.requestId !== "string") return;
    sendMediaResult(event.senderId, request.requestId, result);
  }
  function createMediaCreditEmitter(generation, send) {
    let creditSequence = 0;
    return () => {
      creditSequence += 1;
      const credit = { type: "mediaCredit", protocolVersion: PROTOCOL_VERSION, generation, credits: 1, creditSequence };
      if (global.console && typeof global.console.info === "function") global.console.info("ScreenMirror mediaCredit", { generation, creditSequence });
      send(credit);
    };
  }
  // Diagnostic fingerprint only. Includes actual startup/playback code and closed-over
  // settings plus receiver capabilities; never includes request IDs, endpoints or tokens.
  // FNV-1a is a comparison checksum, not a security hash.
  function effectiveReceiverConfigHash(runtime) {
    const value = JSON.stringify({ schema: 1, revision: RECEIVER_REVISION,
      protocolVersion: PROTOCOL_VERSION, namespace: NAMESPACE, mime: MIME_TYPE,
      maxMessageBytes: MAX_MESSAGE_BYTES, retainedHistorySeconds: RETAINED_HISTORY_SECONDS,
      trimHistoryThresholdSeconds: TRIM_HISTORY_THRESHOLD_SECONDS,
      fastThresholdSeconds: LIVE_EDGE_FAST_THRESHOLD_SECONDS,
      normalThresholdSeconds: LIVE_EDGE_NORMAL_THRESHOLD_SECONDS,
      fastPlaybackRate: LIVE_EDGE_FAST_PLAYBACK_RATE,
      implementation: [runMedia, recoverySeekTarget, stalledLiveEdgeSeekTarget, bufferedTrimEnd, liveEdgePlaybackRate].map(String),
      runtime: { frameCallback: !!runtime.frameCallback, mediaSource: !!runtime.mediaSource,
        avcMIME: !!runtime.avcMIME, sourceBuffer: !!runtime.sourceBuffer, autoplay: runtime.autoplay } });
    let hash = 2166136261;
    for (const byte of new TextEncoder().encode(value)) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
    return `fnv1a32_${hash.toString(16).padStart(8, "0")}`;
  }
  function createInitialAudioCreditDelivery(send, canDeliver) {
    let pending = false; let authenticated = false; let sent = false;
    const flush = () => {
      if (!pending || sent || !authenticated || !canDeliver()) return false;
      if (!send()) return false;
      sent = true; pending = false;
      return true;
    };
    return {
      ready() { pending = true; return flush(); },
      authenticated() { authenticated = true; return flush(); },
      flush,
      close() { pending = false; authenticated = false; },
      // After a reconnect the iPhone starts a fresh audio credit flow, so the
      // initial audioReady must be sent again on the new connection.
      reopen(ready) { sent = false; authenticated = false; pending = !!ready; },
      get sent() { return sent; }
    };
  }
  function runMedia(event, request) {
    const mediaRun = ++activeMediaRun;
    const healthyCatchup = createHealthyLiveEdgeCatchup(mediaRun);
    sendCapabilityDiagnostics(event, request);
    if (!capabilityResult()) {
      sendReceiverDiagnostic(event, request, "receiver_error_before_disconnect_unsupported");
      sendMediaResult(event.senderId, request.requestId, "unsupported");
      return;
    }
    const video = document.getElementById("probe-video");
    document.body.classList.add("media-active");
    document.body.classList.remove("receiver-idle");
    sendMediaResult(event.senderId, request.requestId, `receiver_revision_reported_${RECEIVER_REVISION}`);
    try { sendMediaResult(event.senderId, request.requestId, `effective_receiver_config_hash_${effectiveReceiverConfigHash({
      ...capabilities, frameCallback: typeof video.requestVideoFrameCallback === "function"
    })}`); } catch (_) { /* Diagnostics never gate media startup. */ }
    const pending = []; const maxPending = 8;
    const audioRequested = request.audioCodec === "mp4a.40.2";
    const audioPending = []; const maxAudioPending = 4;
    const flowGeneration = 1; const initialCredits = 8; let mediaReadySent = false;
    let mediaAuthenticated = false; let audioInitAppended = false;
    let playbackSampleTimer; let playbackSamples = 0; let renderedCallbacks = 0; let presentedFrames = 0;
    let lastAppendAtMs = null; let lastRenderAtMs = null; let renderedMediaTime = NaN;
    let decodeDuration = NaN; let displayLead = NaN; let receiverDrops = 0;
    let seekCount = 0; let lastSeekKind = 0; let rateChanges = 0;
    let senderPaused = false; let pendingLiveJump = false; let mediaVisibilityHandler = null;
    let senderReconnect = false; let mediaReconnecting = false; let mediaReconnectRetryTimer; let mediaReconnectGiveUpTimer;
    let mediaStopRequested = false; let livenessProbeTimer; let lastSenderMessageAt = performance.now();
    let source; let buffer; let audioBuffer; let socket; let firstKeyframe = false; let firstMediaAppended = false; let lastAppendingType = 0; let lastAppendingFragment = null; let lastAppendingSyncTimes = []; const syncPoints = []; let firstRendered = false; let playAttempted = false; let initialSeekRequested = false; let initialSeekCompleted = false; let recoverySeekPending = false; let recoverySeekStartedAt = 0; let healthySeekPending = false; let timeUpdated = false; let appendBacklogHighWatermark = 0; let appendedFragments = 0; let initAppendPending = false; let initAppendTimeout; let mediaAppendPending = false; let lastAudioType = 0; let audioTrimPending = false; let audioCreditSequence = 0; let playTimeout; let receiverStopped = false; let stallThresholdMs = 1500; let recoveryTailSeconds = 0.05; let recoveryMinimumLeadSeconds = 0.05; let recoveryTimeoutMs = 3000; let lastPlayback = { time: 0, advancedAt: performance.now(), recoveryAwaitingProgress: false, recoveryTimeout: undefined };
    if (activeReceiverPagehideListener && typeof global.removeEventListener === "function") {
      global.removeEventListener("pagehide", activeReceiverPagehideListener);
    }
    activeReceiverPagehideListener = () => {
      try {
        sendMediaResult(event.senderId, request.requestId,
          receiverStopped ? "receiver_document_pagehide_after_stop" : "receiver_document_pagehide_during_media");
      } catch (_) { /* Lifecycle diagnostics never affect receiver state. */ }
    };
    if (typeof global.addEventListener === "function") {
      global.addEventListener("pagehide", activeReceiverPagehideListener, { once: true });
    }
    let reconnectingScreenTimer;
    let latencyFallback = false; let frameCallbackID;
    // Preserve the existing timeupdate fallback on receivers without rVFC.
    const latencyCorrelations = new Map();
    const sendLatency = (value) => {
      try { if (socket && socket.readyState === 1) { socket.send(JSON.stringify(value)); return true; } } catch (_) {}
      return false;
    };
    const initialAudioCredits = createInitialAudioCreditDelivery(() => {
      const delivered = sendLatency({ type: "audioReady", protocolVersion: PROTOCOL_VERSION, generation: flowGeneration, initialCredits: maxAudioPending });
      if (delivered) {
        try { sendMediaResult(event.senderId, request.requestId, "receiver_audio_initial_credits_sent"); }
        catch (_) { /* Diagnostics never change credit ownership. */ }
      }
      return delivered;
    }, () => !receiverStopped && mediaRun === activeMediaRun && socket && socket.readyState === 1);
    const captureStageMetrics = () => ({ bufferLeadMs: Math.round(bufferedLead(video) * 1000), pendingDepth: Math.max(0, Math.min(maxPending, pending.length)) });
    const sendLatencyStage = (stage, sequence, at, metrics) => {
      const message = makeLatencyStage(flowGeneration, sequence, stage, at, metrics.bufferLeadMs, metrics.pendingDepth);
      if (message) sendLatency(message);
    };
    // Each runMedia call owns one receiver generation/session, so this counter
    // resets when that session is replaced while remaining monotonic in-session.
    let emitMediaCredit = createMediaCreditEmitter(flowGeneration, sendLatency);
    const confirmFirstRendered = (metadata) => {
      if (!canConfirmFirstRendered(firstRendered, firstMediaAppended, metadata)) return;
      firstRendered = true;
      const presentedFrames = Math.max(1, Math.floor(metadata.presentedFrames));
      sendMediaResult(event.senderId, request.requestId, `first_frame_callback_presented_${presentedFrames}`);
      context.sendCustomMessage(NAMESPACE, currentReplySender(event.senderId), { type: "firstRenderedFrame", protocolVersion: PROTOCOL_VERSION, requestId: request.requestId, receiverVersion: RECEIVER_VERSION, appendBacklogHighWatermark });
    };
    const pacing = createFramePacingSummary((result) => sendMediaResult(event.senderId, request.requestId, result));
    const correlations = createFrameCorrelationTracker(flowGeneration,
      (result) => sendMediaResult(event.senderId, request.requestId, result), sendLatencyStage,
      (now, metadata, correlation) => sendLatency({ type: "renderedFrame", generation: correlation.generation, sequence: correlation.sequence, receiverTimeMs: now, mediaTimeMs: Math.round(metadata.mediaTime * 1000), presentedFrames: Number.isFinite(metadata.presentedFrames) ? metadata.presentedFrames : 0, bufferLeadMs: metadata.bufferLeadMs }));
    const clearPlaybackSampleTimer = () => {
      if (playbackSampleTimer !== undefined && typeof global.clearInterval === "function") global.clearInterval(playbackSampleTimer);
      playbackSampleTimer = undefined;
    };
    const sendPeriodicPlaybackSample = () => {
      if (receiverStopped || mediaRun !== activeMediaRun || !mediaAuthenticated || !socket || socket.readyState !== 1) {
        clearPlaybackSampleTimer(); return;
      }
      if (playbackSamples >= 120) { clearPlaybackSampleTimer(); return; }
      const nowMs = performance.now();
      const sample = makePeriodicPlaybackSample(video, buffer, {
        generation: flowGeneration, sampleIndex: playbackSamples + 1, nowMs,
        queueDepth: pending.length, receiverDrops, appendedFragments, renderedCallbacks, presentedFrames,
        uncorrelatedFrames: correlations.snapshot().counts.rendered_frame_uncorrelated_no_fragment_match || 0,
        lastAppendAtMs, lastRenderAtMs, renderedMediaTime, decodeDuration, displayLead,
        seekCount, lastSeekKind, rateChanges
      });
      if (sendLatency(sample)) playbackSamples += 1;
    };
    const startPlaybackSamples = () => {
      if (playbackSampleTimer === undefined && typeof global.setInterval === "function") {
        playbackSampleTimer = global.setInterval(sendPeriodicPlaybackSample, 5000);
      }
    };
    const observeFrame = (now, metadata) => {
      if (receiverStopped) return;
      renderedCallbacks += 1;
      lastRenderAtMs = now;
      if (Number.isFinite(metadata.presentedFrames)) presentedFrames = metadata.presentedFrames;
      renderedMediaTime = metadata.mediaTime;
      decodeDuration = metadata.processingDuration;
      displayLead = Number.isFinite(metadata.expectedDisplayTime) ? (metadata.expectedDisplayTime - now) / 1000 : NaN;
      confirmFirstRendered(metadata);
      // A decoded frame can resume after MSE waiting without another
      // "playing" event. Clear the overlay only on actual frame presentation.
      if (firstRendered && ui && !ui.panel.hidden && !video.paused && !video.ended) showScreen("playing");
      pacing.frame(now, metadata);
      correlations.frame(now, { ...metadata, bufferLeadMs: Math.round(bufferedLead(video) * 1000) });
    };
    const installFrameObserver = () => {
      if (typeof video.requestVideoFrameCallback === "function") {
        sendLatency({ type: "latencyCapability", mode: "requestVideoFrameCallback", features: MEDIA_FEATURES });
        const next = (now, metadata) => { if (receiverStopped) return; observeFrame(now, metadata); frameCallbackID = video.requestVideoFrameCallback(next); };
        frameCallbackID = video.requestVideoFrameCallback(next);
      } else { latencyFallback = true; sendLatency({ type: "latencyCapability", mode: "playbackAckFallback", features: MEDIA_FEATURES }); }
    };
    const clearInitAppendTimeout = () => { if (initAppendTimeout) { global.clearTimeout(initAppendTimeout); initAppendTimeout = undefined; } };
    const clearPlayTimeout = () => { if (playTimeout) { global.clearTimeout(playTimeout); playTimeout = undefined; } };
    const clearRecoveryTimeout = () => { if (lastPlayback.recoveryTimeout) { global.clearTimeout(lastPlayback.recoveryTimeout); lastPlayback.recoveryTimeout = undefined; } };
    const clearReconnectingScreenTimer = () => { if (reconnectingScreenTimer) { global.clearTimeout(reconnectingScreenTimer); reconnectingScreenTimer = undefined; } };
    const scheduleReconnectingScreen = () => {
      // During Wi-Fi grace only the small badge shows; the grace timer decides.
      if (receiverStopped || !firstRendered || reconnectingScreenTimer || senderPaused || mediaReconnecting) return;
      reconnectingScreenTimer = global.setTimeout(() => {
        reconnectingScreenTimer = undefined;
        if (!shouldShowReconnectingScreen(firstRendered, receiverStopped, lastPlayback.advancedAt, performance.now(), stallThresholdMs)) return;
        // Stage 1: keep the frozen picture, show a small corner badge.
        setStallBadge(true);
        sendMediaResult(event.senderId, request.requestId, "receiver_stall_badge_shown");
        const stalledSince = lastPlayback.advancedAt;
        reconnectingScreenTimer = global.setTimeout(() => {
          reconnectingScreenTimer = undefined;
          if (receiverStopped || lastPlayback.advancedAt !== stalledSince) return;
          // Stage 2: still stuck — full "Reconnecting…" panel.
          showScreen("reconnecting");
          reconnectingScreenTimer = global.setTimeout(() => {
            reconnectingScreenTimer = undefined;
            if (receiverStopped || lastPlayback.advancedAt !== stalledSince) return;
            // Diagnostics 25: with the iPhone's Wi‑Fi off the connection goes
            // silent instead of closing, so the TV said "Unlock your iPhone".
            // A phone that supports reconnecting gives up after 15 s and a lock
            // ends sharing cleanly, so 30 s of silence means the phone is gone.
            // Diagnostics 31: silence means nothing at all from the phone, not a
            // frozen picture (a still iPhone screen sends no new frames).
            const endStallIfPhoneSilent = () => {
              if (!stallEndsAsConnectionLost(senderReconnect, lastSenderMessageAt, performance.now())) return false;
              sendMediaResult(event.senderId, request.requestId, "receiver_stall_ended_as_connection_lost");
              mediaStopRequested = true;
              clearMediaReconnectTimers(); mediaReconnecting = false;
              try { socket && socket.close(); } catch (_) {}
              sendMediaResult(event.senderId, request.requestId, "receiver_stop_received");
              clearVideoForReceiverStop("lost");
              return true;
            };
            if (endStallIfPhoneSilent()) return;
            // Stage 3: give a clear next step; resumes by itself if media returns.
            showScreen("stalledLost");
            sendMediaResult(event.senderId, request.requestId, "receiver_stall_gave_up");
            if (!senderReconnect) return;
            // The phone is still talking: keep the session and check again, so a
            // phone that goes quiet later still ends on Connection Lost.
            const watchPhoneSilence = () => {
              reconnectingScreenTimer = global.setTimeout(() => {
                reconnectingScreenTimer = undefined;
                if (receiverStopped || mediaReconnecting || lastPlayback.advancedAt !== stalledSince) return;
                if (!endStallIfPhoneSilent()) watchPhoneSilence();
              }, MEDIA_LIVENESS_PROBE_MS);
            };
            watchPhoneSilence();
          }, STALL_GIVE_UP_AFTER_MS - STALL_FULL_SCREEN_AFTER_MS);
        }, STALL_FULL_SCREEN_AFTER_MS);
      }, stallThresholdMs);
    };
    const clearVideoForReceiverStop = (screen) => {
      if (receiverStopped) return;
      receiverStopped = true;
      clearMediaReconnectTimers(); mediaReconnecting = false; clearLivenessProbe();
      if (mediaVisibilityHandler) { mediaVisibilityListeners.delete(mediaVisibilityHandler); mediaVisibilityHandler = null; }
      healthyCatchup.close();
      healthySeekPending = false;
      recoverySeekPending = false;
      correlations.finish(performance.now());
      pacing.stop(correlations.snapshot().counts);
      if (frameCallbackID !== undefined && typeof video.cancelVideoFrameCallback === "function") video.cancelVideoFrameCallback(frameCallbackID);
      clearRecoveryTimeout();
      clearReconnectingScreenTimer();
      clearPlaybackSampleTimer();
      pending.length = 0;
      audioPending.length = 0;
      audioTrimPending = false;
      initialAudioCredits.close();
      mediaAuthenticated = false;
      // Explicitly release this generation's SourceBuffers (and the audio
      // decoder behind audioBuffer in particular) before detaching src, rather
      // than only relying on garbage collection once these locals go out of
      // scope. On rapid back-to-back casts the next generation's addSourceBuffer
      // call for audio can otherwise run before the platform has freed the
      // previous decoder instance, which throws and silently degrades to
      // video-only.
      try {
        if (source && source.readyState === "open") {
          if (audioBuffer && !audioBuffer.updating) { try { source.removeSourceBuffer(audioBuffer); } catch (_) {} }
          if (buffer && !buffer.updating) { try { source.removeSourceBuffer(buffer); } catch (_) {} }
        }
      } catch (_) {}
      audioBuffer = null; buffer = null;
      try { video.pause(); video.removeAttribute("src"); video.load(); } catch (_) {}
      document.body.classList.remove("media-active");
      document.body.classList.add("receiver-idle");
      showScreen(screen);
      sendMediaResult(event.senderId, request.requestId, "receiver_video_cleared");
      sendMediaResult(event.senderId, request.requestId, "receiver_idle_screen_shown");
      if (screen === "stopped") sendMediaResult(event.senderId, request.requestId, "receiver_casting_stopped_screen_shown");
      if (screen === "lost" || screen === "unreachable") sendMediaResult(event.senderId, request.requestId, "receiver_connection_lost_screen_shown");
    };
    // A photo/video from the iPhone replaces a running cast (as Google's
    // player did when it took over the TV): end this cast cleanly first.
    stopMirroringForPlayer = () => {
      if (receiverStopped || mediaRun !== activeMediaRun) return;
      sendMediaResult(event.senderId, request.requestId, "receiver_mirroring_replaced_by_player");
      try { socket && socket.close(1000, "player"); } catch (_) {}
      clearVideoForReceiverStop("ready");
    };
    const clearLivenessProbe = () => { if (livenessProbeTimer !== undefined && typeof global.clearInterval === "function") global.clearInterval(livenessProbeTimer); livenessProbeTimer = undefined; };
    const clearMediaReconnectTimers = () => {
      if (mediaReconnectRetryTimer) { global.clearTimeout(mediaReconnectRetryTimer); mediaReconnectRetryTimer = undefined; }
      if (mediaReconnectGiveUpTimer) { global.clearTimeout(mediaReconnectGiveUpTimer); mediaReconnectGiveUpTimer = undefined; }
    };
    const stop = (result) => { mediaStopRequested = true; clearMediaReconnectTimers(); mediaReconnecting = false; clearInitAppendTimeout(); clearPlayTimeout(); clearPlaybackSampleTimer(); try { socket && socket.close(); } catch (_) {} sendMediaResult(event.senderId, request.requestId, result); };
    const safePlayRejection = (error) => {
      if (error && error.name === "NotAllowedError") return "play_rejected_not_allowed";
      if (error && error.name === "NotSupportedError") return "play_rejected_not_supported";
      if (error && error.name === "AbortError") return "play_rejected_abort";
      return "play_rejected_other";
    };
    const boundedMs = (value) => Number.isFinite(value) && value >= 0 && value <= 3600 ? Math.round(value * 1000) : null;
    const playbackTelemetry = (checkpoint) => {
      const ranges = video.buffered;
      const hasRange = ranges && ranges.length > 0;
      const durationKind = Number.isNaN(video.duration) ? "nan" : video.duration === Infinity ? "infinite" : Number.isFinite(video.duration) ? "finite" : "unknown";
      sendMediaResult(event.senderId, request.requestId, "playback_state", {
        checkpoint,
        readyState: Math.max(0, Math.min(4, video.readyState || 0)),
        networkState: Math.max(0, Math.min(3, video.networkState || 0)),
        paused: !!video.paused,
        ended: !!video.ended,
        currentTimeMs: boundedMs(video.currentTime) || 0,
        durationKind,
        bufferedLength: Math.max(0, Math.min(8, hasRange ? ranges.length : 0)),
        bufferStartMs: hasRange ? boundedMs(ranges.start(0)) : null,
        bufferEndMs: hasRange ? boundedMs(ranges.end(0)) : null,
        mediaSourceState: source && ["open", "ended", "closed"].includes(source.readyState) ? source.readyState : "unknown",
        sourceBufferUpdating: !!(buffer && buffer.updating),
        videoBufferRanges: Math.max(0, Math.min(8, buffer && buffer.buffered ? buffer.buffered.length : 0)),
        audioBufferRanges: Math.max(0, Math.min(8, audioBuffer && audioBuffer.buffered ? audioBuffer.buffered.length : 0)),
        audioBufferCreated: !!audioBuffer,
        audioInitAppended,
        audioBufferUpdating: !!(audioBuffer && audioBuffer.updating),
        mediaErrorCode: video.error && Number.isInteger(video.error.code) ? video.error.code : 0,
        appendedFragments,
        keyframeAppended: firstKeyframe && firstMediaAppended,
        queueDepth: Math.max(0, Math.min(8, pending.length))
      });
    };
    const attemptPlay = () => {
      if (playAttempted || !initialSeekCompleted || !firstKeyframe || !firstMediaAppended || !buffer || buffer.updating) return;
      playAttempted = true;
      playbackTelemetry("before_play");
      sendMediaResult(event.senderId, request.requestId, "play_attempt_started");
      let promise;
      try { promise = video.play(); } catch (_) { sendMediaResult(event.senderId, request.requestId, "play_synchronous_exception"); return; }
      sendMediaResult(event.senderId, request.requestId, "play_promise_pending");
      playTimeout = global.setTimeout(() => {
        playbackTelemetry("play_pending_timeout");
        sendMediaResult(event.senderId, request.requestId, "play_pending_timeout");
      }, 5000);
      Promise.resolve(promise).then(() => {
        clearPlayTimeout();
        sendMediaResult(event.senderId, request.requestId, "play_promise_resolved");
        if (!receiverStopped && audioRequested && audioBuffer) {
          video.muted = false;
          sendMediaResult(event.senderId, request.requestId, "receiver_audio_unmuted");
        }
      }).catch((error) => {
        clearPlayTimeout();
        sendMediaResult(event.senderId, request.requestId, safePlayRejection(error));
      });
    };
    const ensurePlayablePosition = () => {
      if (initialSeekRequested || !firstKeyframe || !firstMediaAppended || !buffer || buffer.updating || !video.buffered || !video.buffered.length) return;
      const start = video.buffered.start(0);
      const end = video.buffered.end(0);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
      if (video.currentTime >= start && video.currentTime <= end) {
        initialSeekCompleted = true;
        attemptPlay();
        return;
      }
      initialSeekRequested = true;
      seekCount += 1; lastSeekKind = 1;
      playbackTelemetry("initial_seek_requested");
      const target = start + Math.min(0.05, Math.max(0, (end - start) / 2));
      sendMediaResult(event.senderId, request.requestId, "initial_seek_requested");
      try { video.currentTime = target; } catch (_) { sendMediaResult(event.senderId, request.requestId, "initial_seek_failed"); }
    };
    const recoverPlaybackPosition = () => {
      if (!initialSeekCompleted || recoverySeekPending || !firstRendered || !buffer || buffer.updating || !video.buffered || !video.buffered.length) return;
      const target = recoverySeekTarget(video.currentTime, video.buffered.start(0), video.buffered.end(0));
      if (target === null) return;
      recoverySeekPending = true; recoverySeekStartedAt = performance.now();
      seekCount += 1; lastSeekKind = 2;
      sendMediaResult(event.senderId, request.requestId, "receiver_live_edge_recovery_seek");
      try { video.currentTime = target; } catch (_) { recoverySeekPending = false; sendMediaResult(event.senderId, request.requestId, "recovery_seek_failed"); }
    };
    // Mid-cast, the video element can end up paused (seen on MiTV after the
    // iPhone's red status-bar control paused ReplayKit twice and the Cast
    // control session was suspended): media kept arriving for minutes, but
    // every recovery path below requires !video.paused, so the TV stayed on
    // "Reconnecting" forever. A live mirror is never intentionally paused
    // while running, so resume at the newest buffered video. Rate-limited.
    let lastUnexpectedPauseResumeAt = -Infinity;
    const resumeUnexpectedPause = () => {
      if (receiverStopped || mediaRun !== activeMediaRun || !initialSeekCompleted || recoverySeekPending
          || !firstRendered || !video.paused || video.ended || !video.buffered || !video.buffered.length) return;
      const now = performance.now();
      if (now - lastUnexpectedPauseResumeAt < stallThresholdMs) return;
      lastUnexpectedPauseResumeAt = now;
      const last = video.buffered.length - 1;
      const start = video.buffered.start(last); const end = video.buffered.end(last);
      playbackTelemetry("receiver_unexpected_pause_resume");
      sendMediaResult(event.senderId, request.requestId, "receiver_unexpected_pause_resume");
      try {
        if (Number.isFinite(start) && Number.isFinite(end) && end > start
            && (video.currentTime < start || video.currentTime > end)) {
          // Playhead is in a gap (no media there): jump to the newest video;
          // the "seeked" handler calls play() because the element is paused.
          recoverySeekPending = true; recoverySeekStartedAt = performance.now();
          seekCount += 1; lastSeekKind = 4;
          video.currentTime = Math.max(start + 0.05, end - 0.05);
        } else {
          Promise.resolve(video.play()).catch((error) => sendMediaResult(event.senderId, request.requestId, safePlayRejection(error)));
        }
      } catch (_) {
        recoverySeekPending = false;
        sendMediaResult(event.senderId, request.requestId, "receiver_unexpected_pause_resume_failed");
      }
    };
    // After the iPhone resumes, the TV holds old video up to the pause and new
    // video after it. Jump straight to the newest video instead of catching up.
    // Every recovery path waits for the previous seek to finish. If a seek
    // never finishes (diagnostics 11: picture frozen for 2+ min after a pause,
    // no recovery attempted), release it so recovery can jump to live again.
    const releaseStuckRecoverySeek = () => {
      if (!recoverySeekPending || receiverStopped) return;
      if (performance.now() - recoverySeekStartedAt < RECOVERY_SEEK_WATCHDOG_MS) return;
      recoverySeekPending = false;
      healthySeekPending = false;
      try { healthyCatchup.completeSeek(mediaRun); } catch (_) {}
      sendMediaResult(event.senderId, request.requestId, "receiver_recovery_seek_watchdog_released");
    };
    const jumpToLiveAfterResume = () => {
      if (!pendingLiveJump || receiverStopped || recoverySeekPending || !video.buffered || !video.buffered.length) return;
      const last = video.buffered.length - 1;
      const start = video.buffered.start(last); const end = video.buffered.end(last);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
      if (video.currentTime >= start && end - video.currentTime < 1) { pendingLiveJump = false; return; }
      if (video.currentTime >= start) return;
      pendingLiveJump = false;
      recoverySeekPending = true; recoverySeekStartedAt = performance.now();
      seekCount += 1; lastSeekKind = 5;
      sendMediaResult(event.senderId, request.requestId, "receiver_resume_live_jump");
      try { video.currentTime = Math.max(start + 0.05, end - 0.05); } catch (_) { recoverySeekPending = false; }
    };
    const detectPlaybackStall = () => {
      if (video.paused && !video.ended) { if (!senderPaused) resumeUnexpectedPause(); return; }
      if (!initialSeekCompleted || recoverySeekPending || !firstRendered || video.paused || video.ended || !video.buffered || !video.buffered.length) return;
      const start = video.buffered.start(0); const end = video.buffered.end(video.buffered.length - 1);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end - video.currentTime < recoveryMinimumLeadSeconds) return;
      if (performance.now() - lastPlayback.advancedAt < stallThresholdMs) return;
      const target = stalledLiveEdgeSeekTarget(video.currentTime, start, end);
      if (target === null || target - video.currentTime < 0.02) return;
      playbackTelemetry("receiver_playback_stall_detected");
      sendMediaResult(event.senderId, request.requestId, "receiver_playback_stall_detected");
      recoverySeekPending = true; recoverySeekStartedAt = performance.now();
      seekCount += 1; lastSeekKind = 3;
      lastPlayback.recoveryAwaitingProgress = true;
      sendMediaResult(event.senderId, request.requestId, "receiver_live_edge_recovery_seek");
      try {
        video.currentTime = target;
        clearRecoveryTimeout();
        lastPlayback.recoveryTimeout = global.setTimeout(() => {
          if (!lastPlayback.recoveryAwaitingProgress) return;
          lastPlayback.recoveryAwaitingProgress = false;
          sendMediaResult(event.senderId, request.requestId, "receiver_playback_recovery_failed");
          playbackTelemetry("receiver_playback_recovery_failed");
        }, recoveryTimeoutMs);
      } catch (_) {
        recoverySeekPending = false; lastPlayback.recoveryAwaitingProgress = false;
        sendMediaResult(event.senderId, request.requestId, "receiver_playback_recovery_failed");
      }
    };
    const catchUpHealthyPlayback = () => {
      if (receiverStopped || mediaRun !== activeMediaRun || !firstRendered || !initialSeekCompleted
          || recoverySeekPending || !mediaAuthenticated || !socket || socket.readyState !== 1
          || !buffer || buffer.updating || (audioRequested && audioBuffer && audioBuffer.updating)) return;
      const now = performance.now();
      const target = healthyCatchup.consider({
        runID: mediaRun, nowMs: now, currentTime: video.currentTime,
        videoRanges: readBufferedRanges(video.buffered),
        audioRanges: audioRequested && audioBuffer ? readBufferedRanges(audioBuffer.buffered) : [],
        syncPoints, audioRequested, audioReady: !!audioBuffer && audioInitAppended && !video.muted,
        readyState: video.readyState, paused: video.paused, ended: video.ended, seeking: video.seeking,
        mediaError: !!video.error, sourceOpen: !!source && source.readyState === "open",
        videoUpdating: !!buffer && buffer.updating, audioUpdating: !!audioBuffer && audioBuffer.updating,
        pendingDepth: pending.length, progressAgeMs: now - lastPlayback.advancedAt,
        appendAgeMs: lastAppendAtMs === null ? Infinity : now - lastAppendAtMs,
        renderAgeMs: lastRenderAtMs === null ? null : now - lastRenderAtMs
      });
      if (target === null) return;
      recoverySeekPending = true; recoverySeekStartedAt = performance.now();
      healthySeekPending = true;
      seekCount += 1; lastSeekKind = 4;
      playbackTelemetry("healthy_live_edge_catchup_requested");
      sendMediaResult(event.senderId, request.requestId, "healthy_live_edge_catchup_seek");
      try { video.currentTime = target; }
      catch (_) {
        recoverySeekPending = false;
        healthySeekPending = false;
        healthyCatchup.completeSeek(mediaRun);
        sendMediaResult(event.senderId, request.requestId, "healthy_live_edge_catchup_seek_failed");
      }
    };
    const regulateLiveEdge = () => {
      // One element carries both tracks; never speed audible AAC for long.
      const nextRate = audioRequested
        ? (video.playbackRate === 1 ? null : 1)
        : liveEdgePlaybackRate(bufferedLead(video), video.playbackRate);
      if (nextRate === null || nextRate === video.playbackRate) return;
      video.playbackRate = nextRate;
      rateChanges += 1;
      sendMediaResult(event.senderId, request.requestId, nextRate > 1 ? "live_edge_catchup_enabled" : "live_edge_catchup_disabled");
    };
    const appendNext = () => {
      if (!buffer || buffer.updating || !pending.length) return;
      const item = pending.shift(); lastAppendingType = item.type; lastAppendingFragment = item.fragment || null;
      lastAppendingSyncTimes = item.syncTimes || [];
      if (item.type === 1) {
        initAppendPending = true;
        sendMediaResult(event.senderId, request.requestId, `init_append_started_len_${item.payload.byteLength}`);
        initAppendTimeout = global.setTimeout(() => {
          if (initAppendPending) { sendMediaResult(event.senderId, request.requestId, "init_append_timeout"); stop("append_failed"); }
        }, 5000);
      }
      if (item.type === 2) {
        mediaAppendPending = true;
        correlations.start(lastAppendingFragment, performance.now(), captureStageMetrics());
        sendMediaResult(event.senderId, request.requestId, `media_append_started_len_${item.payload.byteLength}`);
      }
      try { buffer.appendBuffer(item.payload); } catch (_) {
        if (item.type === 1) sendMediaResult(event.senderId, request.requestId, "init_append_synchronous_exception");
        if (item.type === 2) sendMediaResult(event.senderId, request.requestId, "media_append_synchronous_exception");
        stop("append_failed");
      }
    };
    const emitAudioCredit = () => {
      if (!audioBuffer || !initialAudioCredits.sent || receiverStopped || mediaRun !== activeMediaRun || !mediaAuthenticated) return;
      audioCreditSequence += 1;
      sendLatency({ type: "audioCredit", protocolVersion: PROTOCOL_VERSION, generation: flowGeneration, credits: 1, creditSequence: audioCreditSequence });
    };
    const degradeAudio = (result) => {
      try { sendMediaResult(event.senderId, request.requestId, result); }
      catch (_) { /* Audio diagnostics cannot block video cleanup. */ }
      audioPending.length = 0;
      audioTrimPending = false;
      initialAudioCredits.close();
      const failedBuffer = audioBuffer;
      audioBuffer = null;
      if (failedBuffer && source && source.readyState === "open" && !failedBuffer.updating) {
        try { source.removeSourceBuffer(failedBuffer); }
        catch (_) { sendMediaResult(event.senderId, request.requestId, "receiver_audio_buffer_remove_failed_video_continues"); }
      }
    };
    const appendNextAudio = () => {
      if (!audioBuffer || audioBuffer.updating || !audioPending.length) return;
      const item = audioPending.shift(); lastAudioType = item.type;
      if (item.type === 4 && !audioInitAppended) {
        degradeAudio("audio_fragment_before_init_video_continues");
        return;
      }
      try {
        audioBuffer.appendBuffer(item.payload);
        sendMediaResult(event.senderId, request.requestId, item.type === 3 ? "audio_init_append_started" : "audio_fragment_append_started");
      } catch (_) {
        degradeAudio("audio_append_failed_video_continues");
      }
    };
    const trimAudioHistory = () => {
      if (receiverStopped || !audioBuffer || !audioInitAppended || audioBuffer.updating || typeof audioBuffer.remove !== "function") return false;
      const ranges = readBufferedRanges(audioBuffer.buffered);
      const current = containingRange(ranges, video.currentTime);
      const end = current ? bufferedTrimEnd(video.currentTime, ranges[0].start, current.end) : null;
      if (end === null) return false;
      audioTrimPending = true;
      try { audioBuffer.remove(0, end); return true; }
      catch (_) { audioTrimPending = false; return false; }
    };
    const enqueueAudio = (item) => {
      if (!audioBuffer) { sendMediaResult(event.senderId, request.requestId, "audio_fragment_ignored_not_ready"); return; }
      if (audioPending.length >= maxAudioPending) {
        audioPending.shift();
        sendMediaResult(event.senderId, request.requestId, "audio_queue_evicted");
      }
      audioPending.push(item);
      appendNextAudio();
    };
    const enqueue = (item) => {
      if (pending.length >= maxPending) { pending.splice(0, pending.length - maxPending + 1); receiverDrops += 1; }
      pending.push(item); appendBacklogHighWatermark = Math.max(appendBacklogHighWatermark, pending.length); appendNext();
    };
    try {
      source = new global.MediaSource(); video.src = global.URL.createObjectURL(source); video.muted = true; video.playsInline = true;
      source.addEventListener("sourceopen", () => {
        try {
          buffer = source.addSourceBuffer(MIME_TYPE);
          sendMediaResult(event.senderId, request.requestId, "source_buffer_created");
          // Rapid successive stop/start cycles can ask the platform to create a
          // new audio decoder instance before the previous generation's one has
          // finished releasing (observed as addSourceBuffer throwing here on a
          // device that has just been through back-to-back broadcasts). That is
          // a transient resource race, not "this device can't play AAC", so one
          // short-delay retry is attempted before degrading to video-only.
          const attachAudioBuffer = (attemptsLeft) => {
            if (receiverStopped || mediaRun !== activeMediaRun || source.readyState !== "open") return;
            try {
              audioBuffer = source.addSourceBuffer(AUDIO_MIME_TYPE);
              sendMediaResult(event.senderId, request.requestId, "receiver_audio_source_buffer_created");
              sendMediaResult(event.senderId, request.requestId, "receiver_audio_ready");
              initialAudioCredits.ready();
              audioBuffer.addEventListener("updateend", () => {
                if (receiverStopped || mediaRun !== activeMediaRun) return;
                if (audioTrimPending) { audioTrimPending = false; appendNextAudio(); return; }
                if (lastAudioType === 3) {
                  audioInitAppended = true;
                  sendMediaResult(event.senderId, request.requestId, "audio_init_append_updateend");
                } else if (lastAudioType === 4 && initialAudioCredits.sent) {
                  sendMediaResult(event.senderId, request.requestId, "audio_fragment_append_updateend");
                  emitAudioCredit();
                }
                if (trimAudioHistory()) return;
                appendNextAudio();
              });
              audioBuffer.addEventListener("error", () => {
                degradeAudio("receiver_audio_error_video_continues");
              });
            } catch (error) {
              audioBuffer = null;
              const reason = (error && error.name) ? error.name : "unknown_error";
              if (attemptsLeft > 0) {
                sendMediaResult(event.senderId, request.requestId, `receiver_audio_source_buffer_retry_scheduled_${reason}`);
                // Back-to-back casts can be seconds apart or milliseconds apart;
                // a device that has just been through many rapid cycles can need
                // much longer than a few seconds to release the previous
                // generation's audio decoder, so this backs off across several
                // attempts, totalling ~24s, before accepting video-only.
                const delayMs = [400, 800, 1600, 3200, 5000, 7000][6 - attemptsLeft] || 7000;
                global.setTimeout(() => attachAudioBuffer(attemptsLeft - 1), delayMs);
                return;
              }
              sendMediaResult(event.senderId, request.requestId, `receiver_audio_unsupported_video_continues_${reason}`);
            }
          };
          if (audioRequested && global.MediaSource.isTypeSupported(AUDIO_MIME_TYPE) === true) {
            attachAudioBuffer(6);
          } else if (audioRequested) {
            sendMediaResult(event.senderId, request.requestId, "receiver_audio_skipped_codec_unsupported");
          }
          buffer.addEventListener("updateend", () => {
            if (receiverStopped || mediaRun !== activeMediaRun) return;
            if (lastAppendingType === 1 && initAppendPending) {
              initAppendPending = false;
              clearInitAppendTimeout();
              sendMediaResult(event.senderId, request.requestId, "init_append_updateend");
              if (!mediaReadySent) {
                mediaReadySent = true;
                sendReceiverDiagnostic(event, request, "receiver_media_ready_received");
                sendLatency({ type: "mediaReady", protocolVersion: PROTOCOL_VERSION, generation: flowGeneration, initialCredits });
              }
            }
            if (lastAppendingType === 2) firstMediaAppended = true;
            if (lastAppendingType === 2 && mediaAppendPending) {
              mediaAppendPending = false;
              appendedFragments += 1;
              lastAppendAtMs = performance.now();
              for (const syncTime of lastAppendingSyncTimes) {
                syncPoints.push(syncTime);
                if (syncPoints.length > 16) syncPoints.shift();
              }
              correlations.append(lastAppendingFragment, performance.now(), captureStageMetrics());
              pacing.append(performance.now());
              sendMediaResult(event.senderId, request.requestId, "media_append_updateend");
              if (mediaReadySent) emitMediaCredit();
              playbackTelemetry("first_media_append");
            }
            ensurePlayablePosition();
            attemptPlay();
            releaseStuckRecoverySeek();
            jumpToLiveAfterResume();
            recoverPlaybackPosition();
            detectPlaybackStall();
            catchUpHealthyPlayback();
            regulateLiveEdge();
            // Preserve a full GOP behind the playhead. Trimming at 0.1 seconds
            // can evict the current decode dependency and force a recovery seek.
            const videoRanges = readBufferedRanges(video.buffered);
            const currentVideoRange = containingRange(videoRanges, video.currentTime);
            const trimEnd = currentVideoRange
              ? bufferedTrimEnd(video.currentTime, videoRanges[0].start, currentVideoRange.end) : null;
            if (trimEnd !== null && typeof buffer.remove === "function" && !buffer.updating) {
              try { buffer.remove(0, trimEnd); } catch (_) {}
            }
            appendNext();
          });
          buffer.addEventListener("error", () => {
            if (lastAppendingType === 1 && initAppendPending) sendMediaResult(event.senderId, request.requestId, "init_append_error_event");
            if (lastAppendingType === 2 && mediaAppendPending) sendMediaResult(event.senderId, request.requestId, "media_append_error_event");
            stop("append_failed");
          });
          buffer.addEventListener("abort", () => {
            if (lastAppendingType === 1 && initAppendPending) sendMediaResult(event.senderId, request.requestId, "init_append_abort_event");
            if (lastAppendingType === 2 && mediaAppendPending) sendMediaResult(event.senderId, request.requestId, "media_append_abort_event");
            stop("append_aborted");
          });
          // Wi-Fi grace (negotiated). A drop after the first picture keeps the
          // frozen picture with the "Reconnecting…" badge and retries the same
          // address; the iPhone holds the connection open for the same window.
          const canReconnectMedia = () => senderReconnect && firstRendered && !receiverStopped
            && !mediaReconnecting && !mediaStopRequested && mediaRun === activeMediaRun;
          const giveUpMediaReconnect = () => {
            if (!mediaReconnecting) return;
            mediaReconnecting = false;
            clearMediaReconnectTimers();
            try { socket && socket.close(); } catch (_) {}
            sendMediaResult(event.senderId, request.requestId, "receiver_media_reconnect_gave_up");
            sendMediaResult(event.senderId, request.requestId, "receiver_stop_received");
            clearVideoForReceiverStop("lost");
          };
          const scheduleMediaReconnectAttempt = () => {
            if (!mediaReconnecting || receiverStopped) return;
            if (mediaReconnectRetryTimer) global.clearTimeout(mediaReconnectRetryTimer);
            mediaReconnectRetryTimer = global.setTimeout(() => {
              mediaReconnectRetryTimer = undefined;
              if (mediaReconnecting && !receiverStopped) openMediaSocket(true);
            }, MEDIA_RECONNECT_RETRY_MS);
          };
          const beginMediaReconnect = () => {
            mediaReconnecting = true;
            // Old-connection data and credits are void; the iPhone restarts both.
            pending.length = 0; audioPending.length = 0;
            mediaReadySent = false;
            clearReconnectingScreenTimer();
            setStallBadge(true);
            sendMediaResult(event.senderId, request.requestId, "receiver_media_reconnect_started");
            mediaReconnectGiveUpTimer = global.setTimeout(giveUpMediaReconnect, MEDIA_RECONNECT_GRACE_MS);
            scheduleMediaReconnectAttempt();
          };
          const finishMediaReconnect = () => {
            mediaReconnecting = false;
            clearMediaReconnectTimers();
            emitMediaCredit = createMediaCreditEmitter(flowGeneration, sendLatency);
            audioCreditSequence = 0;
            initialAudioCredits.reopen(!!audioBuffer);
            // New video starts after a gap: jump to it instead of waiting.
            pendingLiveJump = true;
            lastPlayback.advancedAt = performance.now();
            // The iPhone re-sends "paused" if it is still paused; otherwise a
            // pause from before the drop must not stay on screen.
            if (senderPaused) { senderPaused = false; setBadge(null); }
            sendMediaResult(event.senderId, request.requestId, "receiver_media_reconnected");
          };
          const openMediaSocket = (isReconnect) => {
          sendReceiverDiagnostic(event, request, isReconnect ? "receiver_media_reconnect_attempted" : "receiver_endpoint_connect_attempted");
          let candidate;
          try {
            candidate = new global.WebSocket(request.endpoint);
          } catch (constructorError) {
            if (isReconnect) { scheduleMediaReconnectAttempt(); return; }
            // A page served over https: may have this throw synchronously
            // (mixed-content / Private Network Access rejection) before any
            // onerror/onopen ever fires, which previously left the sender
            // waiting silently for a first-rendered-frame that could never
            // arrive. This is additive diagnostics only, not a transport fix.
            sendReceiverDiagnostic(event, request,
              `receiver_endpoint_websocket_constructor_threw_${(constructorError && constructorError.name) || "unknown"}`);
            stop("websocket_failed");
            return;
          }
          socket = candidate;
          candidate.binaryType = "arraybuffer";
          let socketOpened = false;
          const socketConnectTimeout = global.setTimeout(() => {
            if (!socketOpened) sendReceiverDiagnostic(event, request, "receiver_endpoint_connect_timeout");
          }, 8000);
          candidate.onopen = () => {
            if (socket !== candidate) return;
            socketOpened = true;
            global.clearTimeout(socketConnectTimeout);
            sendReceiverDiagnostic(event, request, isReconnect ? "receiver_media_reconnect_opened" : "receiver_endpoint_fetch_started");
            candidate.send(JSON.stringify({ type: "hello", token: new URL(request.endpoint).pathname.slice(1), protocolVersion: PROTOCOL_VERSION }));
            // The frame observer already runs; a new connection only needs the
            // feature announcement again (the iPhone resets it per connection).
            if (isReconnect) sendLatency({ type: "latencyCapability", mode: latencyFallback ? "playbackAckFallback" : "requestVideoFrameCallback", features: MEDIA_FEATURES });
            else installFrameObserver();
          };
          candidate.onmessage = (message) => {
            if (socket !== candidate) return;
            lastSenderMessageAt = performance.now();
            if (typeof message.data === "string") {
              const control = parse(message.data); if (!control) { stop("protocol_error"); return; }
              if (control.type === "readyForMedia" && control.protocolVersion === PROTOCOL_VERSION && Object.keys(control).length === 2) {
                if (mediaReconnecting) finishMediaReconnect();
                mediaAuthenticated = true;
                startPlaybackSamples();
                initialAudioCredits.authenticated();
                sendReceiverDiagnostic(event, request, "receiver_auth_validation_passed");
                sendReceiverDiagnostic(event, request, "receiver_endpoint_fetch_succeeded");
                return;
              }
              if (control.type === "senderFeatures" && control.protocolVersion === PROTOCOL_VERSION
                  && Object.keys(control).length === 3 && Array.isArray(control.features)) {
                if (control.features.includes("reconnect")) senderReconnect = true;
                if (senderReconnect && livenessProbeTimer === undefined && typeof global.setInterval === "function") {
                  livenessProbeTimer = global.setInterval(() => {
                    if (receiverStopped || mediaReconnecting || senderPaused || !mediaVisibilityHandler) return;
                    if (performance.now() - lastPlayback.advancedAt < MEDIA_LIVENESS_PROBE_MS) return;
                    mediaVisibilityHandler(currentVisibility());
                  }, MEDIA_LIVENESS_PROBE_MS);
                }
                if (control.features.includes("visibility")) {
                  if (!mediaVisibilityHandler) {
                    mediaVisibilityHandler = (visibility) => sendLatency({ type: "receiverVisibility", protocolVersion: PROTOCOL_VERSION, visibility });
                    mediaVisibilityListeners.add(mediaVisibilityHandler);
                  }
                  // Also after a reconnect: the iPhone resets visibility per connection.
                  mediaVisibilityHandler(currentVisibility());
                }
                return;
              }
              if ((control.type === "senderPaused" || control.type === "senderResumed")
                  && control.protocolVersion === PROTOCOL_VERSION && Object.keys(control).length === 2) {
                if (control.type === "senderPaused") {
                  senderPaused = true;
                  clearReconnectingScreenTimer();
                  setBadge("paused");
                  if (!receiverStopped && ui && !ui.panel.hidden && currentScreen === "reconnecting") showScreen("playing");
                  sendMediaResult(event.senderId, request.requestId, "receiver_sender_paused_shown");
                } else {
                  senderPaused = false;
                  setBadge(null);
                  pendingLiveJump = true;
                  lastPlayback.advancedAt = performance.now();
                  sendMediaResult(event.senderId, request.requestId, "receiver_sender_resumed");
                }
                return;
              }
              if (control.type === "normalStop" && control.protocolVersion === PROTOCOL_VERSION && Object.keys(control).length === 2) {
                sendMediaResult(event.senderId, request.requestId, "receiver_stop_received");
                clearVideoForReceiverStop("stopped");
                try { candidate.close(1000, "normal_stop"); } catch (_) {}
                return;
              }
              if (control.type === "clockPing" && Number.isFinite(control.t1) && Number.isInteger(control.sequence)) { const t2 = performance.now(); sendLatency({ type: "clockPong", sequence: control.sequence, t1: control.t1, t2, t3: performance.now() }); return; }
              if (control.type === "frameCorrelation" && Number.isInteger(control.generation) && Number.isInteger(control.sequence) && Number.isFinite(control.mediaTimeMs)) { correlations.control(control, performance.now());
                if (latencyFallback) {
                  if (latencyCorrelations.size >= 256) latencyCorrelations.delete(latencyCorrelations.keys().next().value);
                  latencyCorrelations.set(control.sequence, { generation: control.generation, sequence: control.sequence, mediaTime: control.mediaTimeMs / 1000 });
                }
                return;
              }
              sendReceiverDiagnostic(event, request, "receiver_auth_validation_failed");
              sendReceiverDiagnostic(event, request, "receiver_error_before_disconnect_protocol_error");
              stop("protocol_error"); return;
            }
            const envelope = parseEnvelope(message.data); if (!envelope) { stop("binary_envelope_invalid"); return; }
            if (envelope.type === 1) { enqueue(envelope); return; }
            if (envelope.type === 2) {
              const summary = summarizeFragment(envelope.payload);
              let fragment = null;
              if (summary) {
                fragment = correlations.receive(envelope.sequence, summary.decodeTime / 90000, performance.now(), captureStageMetrics());
                sendMediaResult(event.senderId, request.requestId, `media_fragment_received_len_${envelope.payload.byteLength}`);
                sendMediaResult(event.senderId, request.requestId, `first_fragment_seq_${summary.sequence}_samples_${summary.sampleCount}_tfdt_${summary.decodeTime}_offset_${summary.dataOffset}_payload_${summary.payloadLength}_nal_${summary.firstNALType}`);
              } else {
                sendMediaResult(event.senderId, request.requestId, "media_fragment_layout_invalid");
              }
              firstKeyframe = true;
              enqueue({ ...envelope, fragment, syncTimes: summary ? summary.syncTimes : [] });
              return;
            }
            if (envelope.type === 3 || envelope.type === 4) {
              if (!audioRequested) { sendMediaResult(event.senderId, request.requestId, "audio_envelope_rejected_not_negotiated"); return; }
              enqueueAudio(envelope); return;
            }
            stop("binary_envelope_invalid");
          };
          let socketFailed = false;
          candidate.onerror = () => {
            if (socket !== candidate) return;
            socketFailed = true;
            global.clearTimeout(socketConnectTimeout);
            // During Wi-Fi grace the close event that follows decides what to do.
            if (mediaReconnecting || canReconnectMedia()) return;
            if (!firstRendered) {
              sendReceiverDiagnostic(event, request, "receiver_endpoint_fetch_failed");
              sendReceiverDiagnostic(event, request, "receiver_error_before_disconnect_websocket_error");
            }
            stop("websocket_failed");
          }; candidate.onclose = (closeEvent) => {
            if (socket !== candidate) return;
            global.clearTimeout(socketConnectTimeout);
            mediaAuthenticated = false;
            clearPlaybackSampleTimer();
            initialAudioCredits.close();
            if (mediaReconnecting) { scheduleMediaReconnectAttempt(); return; }
            if (canReconnectMedia()) { beginMediaReconnect(); return; }
            if (!receiverStopped) {
              sendMediaResult(event.senderId, request.requestId, "receiver_stop_received");
              clearVideoForReceiverStop(!firstRendered && socketFailed ? "unreachable" : closeScreen(closeEvent, socketFailed));
            }
            if (!firstRendered) {
              const code = closeEvent && Number.isInteger(closeEvent.code) ? closeEvent.code : 0;
              sendReceiverDiagnostic(event, request, "receiver_endpoint_fetch_failed");
              sendReceiverDiagnostic(event, request, `receiver_error_before_disconnect_websocket_closed_${code}`);
              sendMediaResult(event.senderId, request.requestId, "websocket_closed");
            }
          };
          };
          openMediaSocket(false);
          sendMediaResult(event.senderId, request.requestId, "media_socket_connecting");
        } catch (_) { stop("sourcebuffer_failed"); }
      }, { once: true });
      source.addEventListener("sourceended", () => sendMediaResult(event.senderId, request.requestId, "media_source_state_ended"));
      source.addEventListener("sourceclose", () => sendMediaResult(event.senderId, request.requestId, "media_source_state_closed"));
      video.addEventListener("error", () => sendMediaResult(event.senderId, request.requestId, `media_element_error_code_${video.error ? video.error.code : 0}`));
      video.addEventListener("loadedmetadata", () => sendMediaResult(event.senderId, request.requestId, "media_event_loadedmetadata"));
      video.addEventListener("loadeddata", () => sendMediaResult(event.senderId, request.requestId, "media_event_loadeddata"));
      video.addEventListener("canplay", () => sendMediaResult(event.senderId, request.requestId, "media_event_canplay"));
      video.addEventListener("canplaythrough", () => sendMediaResult(event.senderId, request.requestId, "media_event_canplaythrough"));
      video.addEventListener("waiting", () => {
        scheduleReconnectingScreen();
        sendMediaResult(event.senderId, request.requestId, "media_event_waiting");
      });
      video.addEventListener("stalled", () => {
        scheduleReconnectingScreen();
        sendMediaResult(event.senderId, request.requestId, "media_event_stalled");
      });
      video.addEventListener("seeking", () => sendMediaResult(event.senderId, request.requestId, recoverySeekPending ? "recovery_seek_started" : "initial_seek_started"));
      video.addEventListener("seeked", () => {
        if (receiverStopped || mediaRun !== activeMediaRun) return;
        if (recoverySeekPending) {
          recoverySeekPending = false;
          healthyCatchup.completeSeek(mediaRun);
          const healthy = healthySeekPending;
          healthySeekPending = false;
          sendMediaResult(event.senderId, request.requestId,
            healthy ? "healthy_live_edge_catchup_completed" : "recovery_seek_completed");
          if (!healthy || video.paused) {
            try { Promise.resolve(video.play()).catch((error) => sendMediaResult(event.senderId, request.requestId, safePlayRejection(error))); } catch (_) { sendMediaResult(event.senderId, request.requestId, "recovery_play_synchronous_exception"); }
          }
          return;
        }
        if (!initialSeekRequested) return;
        initialSeekCompleted = true;
        playbackTelemetry("before_play");
        sendMediaResult(event.senderId, request.requestId, "initial_seek_completed");
        attemptPlay();
      });
      video.addEventListener("playing", () => {
        clearReconnectingScreenTimer();
        setStallBadge(false);
        if (!receiverStopped && !ui.panel.hidden) showScreen("playing");
        sendMediaResult(event.senderId, request.requestId, "media_event_playing");
      });
      video.addEventListener("timeupdate", () => {
        if (!timeUpdated) { timeUpdated = true; sendMediaResult(event.senderId, request.requestId, "media_event_timeupdate"); }
        if (video.currentTime > lastPlayback.time + 0.01) {
          lastPlayback.time = video.currentTime;
          lastPlayback.advancedAt = performance.now();
          // Picture is moving again: drop any stall badge or stalled panel.
          setStallBadge(false);
          if (!receiverStopped && ui && !ui.panel.hidden && (currentScreen === "reconnecting" || currentScreen === "stalledLost")) {
            clearReconnectingScreenTimer();
            showScreen("playing");
          }
          if (lastPlayback.recoveryAwaitingProgress) {
            lastPlayback.recoveryAwaitingProgress = false;
            clearRecoveryTimeout();
            sendMediaResult(event.senderId, request.requestId, "receiver_playback_recovered");
            playbackTelemetry("receiver_playback_recovered");
          }
        }
        catchUpHealthyPlayback();
        if (latencyFallback && latencyCorrelations.size) { const mediaTime = video.currentTime; const nearest = Array.from(latencyCorrelations.values()).sort((a, b) => Math.abs(a.mediaTime - mediaTime) - Math.abs(b.mediaTime - mediaTime))[0]; if (nearest && Math.abs(nearest.mediaTime - mediaTime) <= 0.05) { latencyCorrelations.delete(nearest.sequence); sendLatency({ type: "renderedFrame", generation: nearest.generation, sequence: nearest.sequence, receiverTimeMs: performance.now(), mediaTimeMs: Math.round(mediaTime * 1000), presentedFrames: 0, bufferLeadMs: Math.round(bufferedLead(video) * 1000), fallback: true }); } }
      });
    } catch (_) { stop("media_source_failed"); }
  }
  function parseEnvelope(value) {
    if (!(value instanceof ArrayBuffer) || value.byteLength < 14) return null;
    const bytes = new Uint8Array(value); const view = new DataView(value);
    if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== "SMC1" || bytes[4] !== 2 || ![1, 2, 3, 4].includes(bytes[5])) return null;
    const length = view.getUint32(10); if (length !== bytes.length - 14 || length > 1048576) return null;
    return { type: bytes[5], sequence: view.getUint32(6), payload: value.slice(14) };
  }
  function summarizeFragment(value) {
    if (!(value instanceof ArrayBuffer)) return null;
    const bytes = new Uint8Array(value); const view = new DataView(value);
    const readBoxes = (start, end) => {
      const result = []; for (let offset = start; offset + 8 <= end;) {
        const size = view.getUint32(offset); if (size < 8 || offset + size > end) return null;
        result.push({ offset, size, type: String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]) }); offset += size;
      } return result;
    };
    const top = readBoxes(0, bytes.length); if (!top) return null;
    const moof = top.find((box) => box.type === "moof"); const mdat = top.find((box) => box.type === "mdat");
    if (!moof || !mdat) return null;
    const moofChildren = readBoxes(moof.offset + 8, moof.offset + moof.size); if (!moofChildren) return null;
    const mfhd = moofChildren.find((box) => box.type === "mfhd"); const traf = moofChildren.find((box) => box.type === "traf"); if (!mfhd || !traf) return null;
    const trafChildren = readBoxes(traf.offset + 8, traf.offset + traf.size); if (!trafChildren) return null;
    const tfdt = trafChildren.find((box) => box.type === "tfdt"); const trun = trafChildren.find((box) => box.type === "trun"); if (!tfdt || !trun || trun.size < 20) return null;
    const version = bytes[tfdt.offset + 8]; const decodeTime = version === 1 ? Number(view.getBigUint64(tfdt.offset + 12)) : view.getUint32(tfdt.offset + 12);
    const dataOffset = view.getUint32(trun.offset + 16); const payloadStart = moof.offset + dataOffset;
    if (payloadStart < mdat.offset + 8 || payloadStart + 5 > mdat.offset + mdat.size) return null;
    const nalLength = view.getUint32(payloadStart); if (nalLength === 0 || payloadStart + 4 + nalLength > mdat.offset + mdat.size) return null;
    // The sender marks every IDR sample in trun, including an IDR that is
    // not the first sample of a fragment. Bound parsing and index only the
    // successfully appended random-access points.
    const sampleCount = view.getUint32(trun.offset + 12);
    const trunVersion = bytes[trun.offset + 8];
    const flags = view.getUint32(trun.offset + 8) & 0x00ffffff;
    const hasSampleFields = (flags & 0x000701) === 0x000701;
    const hasCTO = (flags & 0x000800) !== 0;
    const stride = hasCTO ? 16 : 12;
    const syncTimes = [];
    if (hasSampleFields && sampleCount > 0 && sampleCount <= 32
        && trun.offset + 20 + sampleCount * stride <= trun.offset + trun.size) {
      let time = decodeTime; let totalSize = 0;
      for (let i = 0; i < sampleCount; i += 1) {
        const offset = trun.offset + 20 + i * stride;
        const duration = view.getUint32(offset); const size = view.getUint32(offset + 4);
        const sampleFlags = view.getUint32(offset + 8);
        totalSize += size;
        if (!duration || !size || totalSize > mdat.size - 8) { syncTimes.length = 0; break; }
        const cto = hasCTO ? (trunVersion === 1 ? view.getInt32(offset + 12) : view.getUint32(offset + 12)) : 0;
        if (sampleFlags === 0x02000000 && Number.isSafeInteger(time + cto) && time + cto >= 0) {
          syncTimes.push((time + cto) / 90000);
        }
        time += duration;
      }
    }
    return { sequence: view.getUint32(mfhd.offset + 12), sampleCount, decodeTime, dataOffset, payloadLength: mdat.size - 8, firstNALType: bytes[payloadStart + 4] & 0x1f, syncStart: syncTimes.includes(decodeTime / 90000), syncTimes };
  }
  function bufferedLead(video) {
    for (let i = 0; i < video.buffered.length; i += 1) if (video.currentTime >= video.buffered.start(i) && video.currentTime <= video.buffered.end(i)) return video.buffered.end(i) - video.currentTime;
    return 0;
  }
  const visibilitySubscribers = new Set();
  let lastReportedVisibility = null;
  function currentVisibility() {
    let documentState = "unknown", cafVisibility = "UNKNOWN", cafStandby = "UNKNOWN";
    try { if (global.document && typeof global.document.visibilityState === "string") documentState = global.document.visibilityState; } catch (_) {}
    try { if (context && typeof context.getVisibilityState === "function") cafVisibility = String(context.getVisibilityState()); } catch (_) {}
    try { if (context && typeof context.getStandbyState === "function") cafStandby = String(context.getStandbyState()); } catch (_) {}
    return resolveVisibility(documentState, cafVisibility, cafStandby);
  }
  function notifyVisibilityChanged() {
    const visibility = currentVisibility();
    notifyMediaVisibility(visibility);
    if (visibility === lastReportedVisibility) return;
    lastReportedVisibility = visibility;
    for (const senderId of visibilitySubscribers) {
      try { context.sendCustomMessage(NAMESPACE, senderId, makeVisibilityReport("visibility-change", visibility)); } catch (_) {}
    }
  }
  function receiverMessage(event) {
    const capabilityQuery = event && validateMediaCapabilityQuery(event.data);
    if (capabilityQuery) {
      if (typeof event.senderId === "string") {
        const canDisplay = (mime, codecs, width, height, fps) => !!(context && typeof context.canDisplayType === "function"
          && context.canDisplayType(mime, codecs, width, height, fps));
        context.sendCustomMessage(NAMESPACE, currentReplySender(event.senderId),
          makeMediaCapabilityReport(capabilityQuery.requestId, mediaCapabilities(canDisplay)));
      }
      return;
    }
    const visibilityQuery = event && validateVisibilityQuery(event.data);
    if (visibilityQuery) {
      if (typeof event.senderId === "string") {
        if (visibilitySubscribers.size >= 4) visibilitySubscribers.delete(visibilitySubscribers.values().next().value);
        visibilitySubscribers.add(event.senderId);
        const visibility = currentVisibility();
        lastReportedVisibility = visibility;
        context.sendCustomMessage(NAMESPACE, event.senderId, makeVisibilityReport(visibilityQuery.requestId, visibility));
      }
      return;
    }
    const readyQuery = event && validateReadyQuery(event.data);
    if (readyQuery) {
      capabilityReadyPromise.then((runtime) => {
        const audioSupported = !!(runtime && runtime.mediaSource) && global.MediaSource.isTypeSupported(AUDIO_MIME_TYPE) === true;
        if (event.senderId) {
          context.sendCustomMessage(NAMESPACE, event.senderId,
            makeReadyReport(readyQuery.requestId, receiverReadinessState, audioSupported));
          lifecycleDiagnostics.readySent(readyQuery.requestId);
        }
      });
      return;
    }
    const probe = event && validateProbe(event.data); if (probe) { capabilityReadyPromise.then(() => runWebSocketProbe(event.senderId, probe)); return; }
    const raw = event && parse(event.data);
    const canReportMediaValidation = raw && raw.type === "startMedia" && typeof raw.requestId === "string" && REQUEST_ID.test(raw.requestId);
    if (canReportMediaValidation) {
      sendReceiverDiagnostic(event, raw, "receiver_namespace_opened");
      sendReceiverDiagnostic(event, raw, "receiver_first_message_received");
    }
    const media = event && validateMediaStart(event.data);
    if (media) {
      stopPlayerForMirroring();
      lifecycleDiagnostics.mediaRequested();
      emitReceiverStartup(event, media);
      sendReceiverDiagnostic(event, media, `receiver_page_loaded_revision_${RECEIVER_REVISION}`);
      sendReceiverDiagnostic(event, media, "receiver_media_payload_validation_passed");
      capabilityReadyPromise.then(() => runMedia(event, media));
      return;
    }
    if (canReportMediaValidation) {
      sendReceiverDiagnostic(event, raw, "receiver_media_payload_validation_failed");
    }
    // Unrecognized commands have no user-facing presentation.
  }
  function runWebSocketProbe(senderId, request) {
    if (!capabilityResult()) { send(senderId, request.requestId, RESULT.FAILED); return; }
    let socket;
    let finished = false;
    let timeoutRef = { id: null };
    const complete = (result, terminalStatus, probeAckStatus) => {
      if (finished) return;
      finished = true;
      if (timeoutRef.id !== null) global.clearTimeout(timeoutRef.id);
      try { socket && socket.close(); } catch (_) {}
      capabilities = Object.freeze({ ...capabilities, probeAckStatus, terminalStatus });
      send(senderId, request.requestId, result);
      // Probe completion does not overwrite the casting screen.
    };
    let opened = false;
    try {
      socket = new global.WebSocket(request.endpoint);
      socket.onopen = () => {
        opened = true;
        capabilities = Object.freeze({ ...capabilities, websocketAttempted: true, websocketLifecycle: "opened" });
        socket.send(JSON.stringify({ type: "hello", token: new URL(request.endpoint).pathname.slice(1) }));
      };
      socket.onmessage = (message) => {
        const acknowledgement = parse(message.data);
        if (acknowledgement && acknowledgement.type === "ack" && Object.keys(acknowledgement).length === 1) {
          capabilities = Object.freeze({ ...capabilities, websocketAuthenticated: true, websocketLifecycle: "ack_received" });
          socket.send(JSON.stringify({ type: "confirmed" }));
          global.setTimeout(() => complete(RESULT.PASS, "capability_pass", "confirmed"), 50);
        } else {
          complete(RESULT.FAILED, "capability_failed", "rejected");
        }
      };
      socket.onerror = () => {
        if (capabilities.websocketAuthenticated) {
          complete(RESULT.PASS, "capability_pass", "confirmed");
          return;
        }
        capabilities = Object.freeze({ ...capabilities, websocketLifecycle: opened ? "error_after_open" : "error_before_open" });
        complete(RESULT.WEBSOCKET_FAILED, "capability_failed", "transport_error");
      };
      socket.onclose = () => {
        if (!finished) {
          if (capabilities.websocketAuthenticated) {
            complete(RESULT.PASS, "capability_pass", "confirmed");
            return;
          }
          capabilities = Object.freeze({ ...capabilities, websocketLifecycle: opened ? "closed_before_auth" : "error_before_open" });
          complete(RESULT.WEBSOCKET_FAILED, "capability_failed", "transport_error");
        }
      };
    } catch (error) {
      const securityRejected = error && error.name === "SecurityError";
      capabilities = Object.freeze({ ...capabilities, websocketLifecycle: securityRejected ? "constructor_security_rejected" : "error_before_open" });
      complete(securityRejected ? RESULT.MIXED_CONTENT_BLOCKED : RESULT.WEBSOCKET_FAILED, "capability_failed", "transport_error");
      return;
    }
    timeoutRef.id = global.setTimeout(() => {
      capabilities = Object.freeze({ ...capabilities, websocketLifecycle: "transport_timeout" });
      complete(RESULT.WEBSOCKET_FAILED, "capability_failed", "transport_error");
    }, 5000);
  }
  function testCapabilities(video) {
    const result = { webSocketAPI: typeof global.WebSocket === "function", mediaSource: typeof global.MediaSource === "function", avcMIME: false, sourceBuffer: false, autoplay: "deferred", websocketAttempted: false, websocketAuthenticated: false, probeAckStatus: "not_attempted", terminalStatus: "capability_partial", websocketLifecycle: "not_attempted" };
    let avcMIMEException = "none";
    if (result.mediaSource) {
      try { result.avcMIME = global.MediaSource.isTypeSupported(MIME_TYPE) === true; }
      catch (error) { avcMIMEException = safeException(error); }
    }
    const sourceBufferReady = new Promise((resolve) => {
      if (!result.avcMIME) { capabilityProbeTrace.settled = "avc_unsupported"; resolve(false); return; }
      const startedAt = receiverNow();
      let timedOut = false;
      try {
        const source = new global.MediaSource();
        capabilityProbeTrace.source = source;
        video.src = global.URL.createObjectURL(source);
        const timeout = global.setTimeout(() => {
          timedOut = true;
          capabilityProbeTrace.settled = "timeout_before_sourceopen";
          capabilityProbeTrace.sourceStateAtTimeout = safeMediaSourceState(source);
          resolve({ value: false, exception: "timeout" });
        }, 1500);
        source.addEventListener("sourceopen", () => {
          global.clearTimeout(timeout);
          capabilityProbeTrace.sourceOpen = timedOut ? "after_timeout" : "before_timeout";
          const observedAt = receiverNow();
          const delay = Number.isFinite(startedAt) && Number.isFinite(observedAt) ? observedAt - startedAt : -1;
          capabilityProbeTrace.sourceOpenDelayMs = Number.isFinite(delay) && delay >= 0 ? Math.min(60000, Math.round(delay)) : -1;
          capabilityProbeTrace.addSourceBuffer = "attempted";
          try {
            const added = !!source.addSourceBuffer(MIME_TYPE);
            capabilityProbeTrace.addSourceBuffer = added ? "succeeded" : "returned_false";
            if (!timedOut) capabilityProbeTrace.settled = added ? "sourcebuffer_created" : "sourcebuffer_unavailable";
            resolve({ value: added, exception: "none" });
          } catch (error) {
            capabilityProbeTrace.addSourceBuffer = "threw";
            if (!timedOut) capabilityProbeTrace.settled = "sourcebuffer_exception";
            resolve({ value: false, exception: safeException(error) });
          }
        }, { once: true });
      } catch (error) {
        capabilityProbeTrace.settled = capabilityProbeTrace.source ? "attach_exception" : "constructor_exception";
        resolve({ value: false, exception: safeException(error) });
      }
    });
    return sourceBufferReady.then((sourceBufferProbe) => {
      const sourceBuffer = typeof sourceBufferProbe === "boolean" ? sourceBufferProbe : sourceBufferProbe.value;
      const sourceBufferException = typeof sourceBufferProbe === "boolean" ? "none" : sourceBufferProbe.exception;
      capabilities = Object.freeze({ ...result, sourceBuffer });
      capabilityProbe = Object.freeze({
        avcMIMEOutcome: result.avcMIME ? "true" : "false",
        avcMIMEException,
        sourceBufferOutcome: sourceBuffer ? "true" : "false",
        sourceBufferException
      });

      return capabilities;
    });
  }
  // Observability only. No timers, transport messages, CAF mutations or media.
  function createLifecycleDiagnostics(env, scriptStartedAt) {
    const VERSION = "caf-idle-observe-20261017-01";
    const MAX_EVENTS = 64, MAX_NORMAL = 48, WINDOW_MS = 360000;
    const records = [], counts = Object.create(null);
    const critical = new Set(["receiver_caf_shutdown", "receiver_caf_error", "receiver_pagehide",
      "receiver_beforeunload", "receiver_page_error", "receiver_promise_rejection"]);
    const names = new Set(["receiver_page_started", "receiver_caf_context_initialized",
      "receiver_caf_start_requested", "receiver_caf_start_returned", "receiver_caf_options_snapshot", "receiver_caf_ready",
      "receiver_caf_shutdown", "receiver_sender_connected", "receiver_sender_disconnected",
      "receiver_caf_error", "receiver_caf_visibility_changed", "receiver_caf_standby_changed",
      "receiver_visibility_changed", "receiver_pagehide", "receiver_beforeunload",
      "receiver_page_error", "receiver_promise_rejection", "receiver_ready_transmitted",
      "receiver_ready_correlation", "receiver_media_request_observed", "receiver_diag_hook_unavailable"]);
    const token = (value, allowed) => typeof value === "string" && allowed.includes(value.toUpperCase())
      ? value.toUpperCase() : "UNKNOWN";
    const safeError = (value) => {
      try { return token(value && value.name, ["ERROR", "TYPEERROR", "REFERENCEERROR", "RANGEERROR",
        "SYNTAXERROR", "URIERROR", "EVALERROR", "AGGREGATEERROR", "DOMEXCEPTION"]); }
      catch (_) { return "UNKNOWN"; }
    };
    const now = () => { try { const n = env.performance && env.performance.now(); return Number.isFinite(n) ? n : null; } catch (_) { return null; } };
    const wall = () => { try { const n = env.Date.now(); return Number.isFinite(n) ? n : null; } catch (_) { return null; } };
    const startedAt = Number.isFinite(scriptStartedAt) ? scriptStartedAt : now(), startedWall = wall();
    let context = null, framework = null, normalCount = 0, elapsed = 0, recording = false, mediaRequested = false;
    let nonce = "unavailable";
    try { nonce = `page_${env.Math.random().toString(36).slice(2, 14)}`; } catch (_) {}
    function snapshotState() {
      const state = { cafVersion: "unavailable", cafState: "UNKNOWN", playerState: "UNKNOWN", cafVisibility: "UNKNOWN", cafStandby: "UNKNOWN", senderCount: null };
      try {
        const version = framework && framework.VERSION;
        if (typeof version === "string" && /^[A-Za-z0-9._-]{1,32}$/.test(version)) state.cafVersion = version;
      } catch (_) {}
      try { if (context && typeof context.getSystemState === "function") state.cafState = token(context.getSystemState(),
        ["NOT_STARTED", "STARTING_IN_BACKGROUND", "STARTING", "READY", "STOPPING_IN_BACKGROUND", "STOPPING"]); } catch (_) {}
      try { if (context && typeof context.getVisibilityState === "function") state.cafVisibility = token(context.getVisibilityState(), ["VISIBLE", "NOT_VISIBLE", "UNKNOWN"]); } catch (_) {}
      try { if (context && typeof context.getStandbyState === "function") state.cafStandby = token(context.getStandbyState(), ["STANDBY", "NOT_STANDBY", "UNKNOWN"]); } catch (_) {}
      try {
        const player = context && typeof context.getPlayerManager === "function" && context.getPlayerManager();
        if (player && typeof player.getPlayerState === "function") state.playerState = token(player.getPlayerState(),
          ["IDLE", "LOADING", "BUFFERING", "PLAYING", "PAUSED"]);
      } catch (_) {}
      try {
        const senders = context && typeof context.getSenders === "function" && context.getSenders();
        if (Array.isArray(senders)) state.senderCount = Math.min(16, senders.length);
      } catch (_) {}
      return state;
    }
    function record(name, detail) {
      if (recording) return null;
      recording = true;
      try {
        const current = now(), currentWall = wall();
        const delta = current !== null && startedAt !== null ? current - startedAt
          : currentWall !== null && startedWall !== null ? currentWall - startedWall : 0;
        elapsed = Math.max(elapsed, Number.isFinite(delta) ? delta : 0);
        const important = critical.has(name);
        if (!names.has(name) || elapsed > WINDOW_MS || records.length >= MAX_EVENTS
          || (!important && normalCount >= MAX_NORMAL) || (counts[name] || 0) >= (important ? 2 : 6)) return null;
        counts[name] = (counts[name] || 0) + 1;
        if (!important) normalCount += 1;
        const entry = { event: name, diagnosticVersion: VERSION, pageNonce: nonce,
          sequence: records.length + 1, elapsedMs: Math.round(elapsed), monotonicMs: current,
          wallTimeMs: currentWall, receiverRevision: RECEIVER_REVISION, mediaRequested, ...snapshotState() };
        try { entry.documentVisibility = token(env.document && env.document.visibilityState, ["VISIBLE", "HIDDEN", "PRERENDER", "UNLOADED"]); } catch (_) {}
        detail = detail || {};
        if (typeof detail.persisted === "boolean") entry.persisted = detail.persisted;
        if (typeof detail.errorClass === "string") entry.errorClass = token(detail.errorClass,
          ["ERROR", "TYPEERROR", "REFERENCEERROR", "RANGEERROR", "SYNTAXERROR", "URIERROR", "EVALERROR", "AGGREGATEERROR", "DOMEXCEPTION"]);
        if (typeof detail.disconnectReason === "string") entry.disconnectReason = token(detail.disconnectReason,
          ["REQUESTED_BY_SENDER", "ERROR", "UNKNOWN"]);
        if (typeof detail.requestHash === "string" && /^[0-9a-f]{24}$/.test(detail.requestHash)) entry.requestHash = detail.requestHash;
        if (Number.isInteger(detail.readySequence) && detail.readySequence > 0 && detail.readySequence <= MAX_EVENTS) entry.readySequence = detail.readySequence;
        if (typeof detail.phase === "string") entry.phase = token(detail.phase, ["GLOBAL", "CAF", "PAGE"]);
        if (typeof detail.idleTimeoutOption === "string") entry.idleTimeoutOption = token(detail.idleTimeoutOption, ["DEFAULT", "TRUE", "FALSE"]);
        if (typeof detail.maxInactivityOption === "string") entry.maxInactivityOption = token(detail.maxInactivityOption, ["DEFAULT", "EXPLICIT", "UNKNOWN"]);
        if (Number.isFinite(detail.maxInactivitySeconds) && detail.maxInactivitySeconds >= 0 && detail.maxInactivitySeconds <= 3600) entry.maxInactivitySeconds = detail.maxInactivitySeconds;
        const frozen = Object.freeze(entry);
        records.push(frozen);
        try { if (env.console && typeof env.console.info === "function") env.console.info("ScreenMirror lifecycle", frozen); } catch (_) {}
        return entry.sequence;
      } catch (_) { return null; }
      finally { recording = false; }
    }
    function listen(target, event, callback, phase) {
      try { if (target && typeof target.addEventListener === "function") target.addEventListener(event, (value) => { try { callback(value); } catch (_) {} }); }
      catch (_) { record("receiver_diag_hook_unavailable", { phase }); }
    }
    function installGlobal() {
      listen(env.document, "visibilitychange", () => record("receiver_visibility_changed"), "PAGE");
      listen(env, "pagehide", (event) => record("receiver_pagehide", { persisted: !!(event && event.persisted) }), "GLOBAL");
      listen(env, "beforeunload", () => { record("receiver_beforeunload"); }, "GLOBAL");
      listen(env, "error", (event) => record("receiver_page_error", { errorClass: safeError(event && event.error) }), "GLOBAL");
      listen(env, "unhandledrejection", (event) => record("receiver_promise_rejection", { errorClass: safeError(event && event.reason) }), "GLOBAL");
      record("receiver_page_started");
    }
    function installCAF(value, api) {
      context = value; framework = api;
      record("receiver_caf_context_initialized");
      const mapping = { READY: "receiver_caf_ready", SHUTDOWN: "receiver_caf_shutdown",
        SENDER_CONNECTED: "receiver_sender_connected", SENDER_DISCONNECTED: "receiver_sender_disconnected",
        ERROR: "receiver_caf_error", VISIBILITY_CHANGED: "receiver_caf_visibility_changed",
        STANDBY_CHANGED: "receiver_caf_standby_changed" };
      for (const key of Object.keys(mapping)) {
        try {
          const type = api && api.system && api.system.EventType && api.system.EventType[key];
          if (typeof type !== "string") continue;
          listen(context, type, (event) => record(mapping[key], key === "SENDER_DISCONNECTED"
            ? { disconnectReason: event && event.reason } : {}), "CAF");
        } catch (_) { record("receiver_diag_hook_unavailable", { phase: "CAF" }); }
      }
    }
    function readySent(requestID) {
      const sequence = record("receiver_ready_transmitted");
      // Never await diagnostics or put identifiers in console/Ready payloads.
      try {
        if (sequence === null || !env.crypto || !env.crypto.subtle || typeof requestID !== "string") return;
        Promise.resolve(env.crypto.subtle.digest("SHA-256", new env.TextEncoder().encode(requestID)))
          .then((bytes) => {
            try {
              const hash = Array.from(new Uint8Array(bytes).slice(0, 12)).map((v) => v.toString(16).padStart(2, "0")).join("");
              record("receiver_ready_correlation", { requestHash: hash, readySequence: sequence });
            } catch (_) {}
          }).catch(() => {});
      } catch (_) {}
    }
    function optionsSnapshot(options) {
      try {
        const idle = options.disableIdleTimeout, inactivity = options.maxInactivity;
        record("receiver_caf_options_snapshot", { idleTimeoutOption: typeof idle === "boolean" ? String(idle) : "DEFAULT",
          maxInactivityOption: inactivity === undefined ? "DEFAULT" : "EXPLICIT", maxInactivitySeconds: inactivity });
      } catch (_) { record("receiver_diag_hook_unavailable", { phase: "CAF" }); }
    }
    return Object.freeze({ record, installGlobal, installCAF, readySent, optionsSnapshot,
      mediaRequested() { mediaRequested = true; record("receiver_media_request_observed"); },
      snapshot() { return records.slice(); }, diagnosticVersion: VERSION });
  }
  const lifecycleDiagnostics = createLifecycleDiagnostics(global, startupTiming.receiver_page_script_started);
  try { lifecycleDiagnostics.installGlobal(); } catch (_) {}
  try { global.ScreenMirrorReceiverLifecycleDiagnostics = Object.freeze({
    diagnosticVersion: lifecycleDiagnostics.diagnosticVersion, snapshot: () => lifecycleDiagnostics.snapshot() }); } catch (_) {}

  function boot() {
    ui = { panel: document.getElementById("idle-screen"), title: document.getElementById("status-title"), detail: document.getElementById("status-detail"),
      chip: document.getElementById("phone-chip"), steps: document.getElementById("status-steps"), content: document.getElementById("status-content") };
    screenLanguage = resolveScreenLanguage(deviceLanguages());
    applyScreenLanguage();
    // Design preview: receiver.html?preview=<screen> renders one screen without
    // Google Cast (for reviewing TV screens in a browser). No effect on TVs.
    try {
      const preview = new URLSearchParams(global.location && global.location.search).get("preview");
      if (preview && SCREEN_COPY[preview]) { showScreen(preview); cancelIdleReturnToHomeTimer(); return; }
      if (preview === "stall") { showScreen("ready"); ui.panel.hidden = true; setStallBadge(true); return; }
      if (preview === "paused") { showScreen("ready"); ui.panel.hidden = true; setBadge("paused"); return; }
    } catch (_) {}
    showScreen("ready");
    const video = document.getElementById("probe-video");
    capabilityReadyPromise = testCapabilities(video);
    if (!global.cast || !global.cast.framework) { showScreen("lost"); return; }
    context = global.cast.framework.CastReceiverContext.getInstance();
    lifecycleDiagnostics.installCAF(context, global.cast.framework);
    if (typeof context.addEventListener === "function") {
      const types = global.cast.framework.system.EventType;
      context.addEventListener(types.READY, () => recordReceiverStartup("receiver_caf_context_ready"));
      context.addEventListener(types.SENDER_CONNECTED, (event) => {
        if (!event || typeof event.senderId !== "string") return;
        if (senderConnections.size >= 4) senderConnections.delete(senderConnections.keys().next().value);
        senderConnections.set(event.senderId, receiverNow());
        // Previously silent: the receiver knew a phone had connected but
        // never said so on screen, so a slow or failed handshake looked
        // identical to nothing happening. Only show it while still idle —
        // never interrupt an already-playing cast or override a more
        // specific in-progress state.
        cancelNoSenderTimer();
        if (receiverReadinessState !== "mirroring" && !playerActive && ui && ui.panel.hidden === false) {
          showScreen("connected");
          clearConnectedWithoutStartTimer();
          connectedWithoutStartTimer = global.setTimeout(() => {
            connectedWithoutStartTimer = null;
            if (currentScreen === "connected") showScreen("waitingForStart");
          }, CONNECTED_WITHOUT_START_MS);
        }
      });
      if (types.SENDER_DISCONNECTED) context.addEventListener(types.SENDER_DISCONNECTED, () => {
        let senders = 1;
        try { senders = typeof context.getSenders === "function" ? context.getSenders().length : 1; } catch (_) {}
        if (senders === 0 && currentScreen !== "playing") scheduleNoSenderReturnToHome();
      });
    }
    try {
      const types = global.cast.framework.system.EventType;
      if (typeof context.addEventListener === "function") {
        if (types.VISIBILITY_CHANGED) context.addEventListener(types.VISIBILITY_CHANGED, notifyVisibilityChanged);
        if (types.STANDBY_CHANGED) context.addEventListener(types.STANDBY_CHANGED, notifyVisibilityChanged);
        if (types.SENDER_DISCONNECTED) context.addEventListener(types.SENDER_DISCONNECTED, (event) => {
          if (event && typeof event.senderId === "string") visibilitySubscribers.delete(event.senderId);
        });
      }
      document.addEventListener("visibilitychange", notifyVisibilityChanged);
    } catch (_) {}
    context.addCustomMessageListener(NAMESPACE, receiverMessage);
    recordReceiverStartup("receiver_namespace_registered");
    const options = new global.cast.framework.CastReceiverOptions();
    options.customNamespaces = { [NAMESPACE]: global.cast.framework.system.MessageType.JSON };
    // This receiver streams raw MSE video over its own namespace and never loads a CAF
    // media session, so CAF's default no-media idle shutdown (~300s) must be disabled here.
    options.disableIdleTimeout = true;
    installMediaPlayer(global.cast.framework);
    lifecycleDiagnostics.optionsSnapshot(options);
    lifecycleDiagnostics.record("receiver_caf_start_requested");
    context.start(options);
    lifecycleDiagnostics.record("receiver_caf_start_returned");

  }
  global.ScreenMirrorReceiverCapabilityGate = Object.freeze({ chooseReplySender, validateMediaCapabilityQuery, mediaCapabilities, makeMediaCapabilityReport, publishMediaDuration, HEVC_PROBES, SCREEN_RTL_LANGUAGES, playerActive: () => playerActive, SCREEN_TRANSLATIONS, SCREEN_EXTRA_COPY_EN, resolveScreenLanguage, screenLanguage: () => screenLanguage, MEDIA_FEATURES, MEDIA_RECONNECT_GRACE_MS, MEDIA_RECONNECT_RETRY_MS, MEDIA_LIVENESS_PROBE_MS, RECOVERY_SEEK_WATCHDOG_MS, effectiveReceiverConfigHash, SCREEN_COPY, SCREEN_SHOWS_PHONE_CHIP, SCREEN_SHOWS_STEPS, STALL_FULL_SCREEN_AFTER_MS, STALL_GIVE_UP_AFTER_MS, CONNECTED_WITHOUT_START_MS, NO_SENDER_RETURN_TO_HOME_MS, IDLE_RETURN_TO_HOME_STATES, closeScreen, MIME_TYPE, AUDIO_MIME_TYPE, RESULT, validEndpoint, validateProbe, validateMediaStart, validateReadyQuery, makeReadyReport, validateVisibilityQuery, resolveVisibility, makeVisibilityReport, receiverReadinessStateForScreen, recoverySeekTarget, stalledLiveEdgeSeekTarget, bufferedTrimEnd, liveEdgePlaybackRate, readBufferedRanges, createHealthyLiveEdgeCatchup, summarizeFragment, makeLatencyStage, makePeriodicPlaybackSample, canConfirmFirstRendered, shouldShowReconnectingScreen, stallEndsAsConnectionLost, renderedCorrelationStrategy, createMediaCreditEmitter, createInitialAudioCreditDelivery, createFrameCorrelationTracker, createFramePacingSummary, receiverRevision: RECEIVER_REVISION, receiverStopDiagnostics: Object.freeze(["receiver_stop_received", "receiver_video_cleared", "receiver_idle_screen_shown", "receiver_casting_stopped_screen_shown", "receiver_connection_lost_screen_shown", "receiver_document_pagehide_after_stop"]), capabilityResult: () => capabilityResult(), snapshot: () => ({ ...capabilities }), capabilityDiagnosticResults: () => capabilityDiagnosticResults() });
  if (typeof document !== "undefined") document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", boot, { once: true }) : boot();
})(globalThis);
