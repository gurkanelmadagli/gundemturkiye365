(function () {
  const IS_FILE = window.location.protocol === "file:";
  const isLocalHost =
    IS_FILE ||
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1";
  const metaApi =
    document.querySelector('meta[name="gundem365-api-origin"]') ||
    document.querySelector('meta[name="gundem360-api-origin"]');
  const metaOrigin = metaApi && metaApi.getAttribute("content") ? String(metaApi.getAttribute("content")).trim() : "";
  const SITE = String(
    window.__GUNDEM365_SITE__ ||
      window.__GUNDEM360_SITE__ ||
      (isLocalHost ? metaOrigin.replace(/\/$/, "") || "http://localhost:3000" : "")
  ).replace(/\/$/, "");
  const API = SITE ? SITE + "/api/news" : "/api/news";
  /** Sunucu RSS önbelleğiyle uyumlu: periyodik haber yenilemesi (ms) */
  const NEWS_POLL_MS = 120000;
  /** /api/tr-pulse (deprem + döviz); sunucuda deprem ~12s, kur ~60s tazelenir */
  const FX_POLL_MS = 12000;
  /** Hava durumu (IP + Open-Meteo): daha seyrek yenileme */
  const WEATHER_POLL_MS = 600000;
  /** Son depremler kutusunda gösterilecek satır (API en fazla bu kadar gönderir) */
  const PULSE_QUAKE_SHOW = 4;
  /** Arşiv API sayfa boyutu (`/api/news/archive` ile aynı üst sınır) */
  const ARCHIVE_PAGE_SIZE = 24;
  /** Ana sayfa slider: en fazla kaç haber, otomatik geçiş süresi (ms) */
  const HOME_SLIDER_MAX = 10;
  const HOME_SLIDER_MS = 7000;
  let homeSliderTimer = null;
  let homeSliderIdx = 0;
  /** Haber yükü hata verince artar; geç gelen /api/tr-pulse yanıtı eski (başarısız) isteğe aitse yoksayılır */
  let trPulseRenderGeneration = 0;
  const BRAND_KICKER = "GündemTürkiye365.com";
  /** Tarayıcı sekmesi ve document.title için görünen ad */
  const SITE_TAB_TITLE = "Gündem Türkiye 365";

  const STATIC_ABOUT_HTML = `<article class="static-article">
  <h1>Hakkımızda</h1>
  <p>
    <strong>${BRAND_KICKER}</strong>, Türkiye ve dünyadan güncel haber başlıklarını ve özetlerini tek ekranda
    sunmayı amaçlayan bir haber akışı sitesidir. İçerikler; güvenilir RSS kaynakları ve kamuya açık veri
    akışları üzerinden derlenir, kategorilere ayrılır ve okunabilir bir arayüzde gösterilir.
  </p>
  <h2>Nasıl çalışırız?</h2>
  <p>
    Haber kartlarında gördüğünüz metinler çoğunlukla kaynak yayının özet veya manşet alanından gelir; tam metin
    için her zaman ilgili kaynağa giden bağlantıyı kullanmanızı öneririz. Son deprem bilgisi ve döviz kutusu
    gibi yan modüller ise resmi veya açık lisanslı uç noktalardan okunur.
  </p>
  <h2>Telif ve sorumluluk</h2>
  <p>
    Yayınlanan haberlerin telif ve kullanım koşulları ilgili ajans veya siteye aittir. Biz yalnızca özet ve
    bağlantı sağlarız; hukuki veya ticari talepler için doğrudan kaynak kuruluşla iletişime geçilmelidir.
  </p>
  <h2>Tasarım</h2>
  <p>
    Arayüz tasarımı <strong>Eviva Software</strong> tarafından yapılmıştır. İletişim ve iş birliği için
    <a href="#/iletisim">İletişim</a> sayfamızdaki e-posta adreslerini kullanabilirsiniz.
    Kişisel veriler için <a href="#/gizlilik">Gizlilik</a> sayfasına bakın.
    Site kullanım koşulları için     <a href="#/hizmet-sartlari">Hizmet Şartları</a> metnine bakın.
    Yasal ve yayın bilgileri için <a href="#/kunye">Künye</a> sayfasına bakın.
  </p>
</article>`;

  const STATIC_KUNYE_HTML = `<article class="static-article">
  <h1>Künye</h1>
  <p>
    Bu sayfa, <strong>${BRAND_KICKER}</strong> internet yayınına ilişkin tanıtıcı ve iletişim bilgilerini içerir.
  </p>
  <h2>Yayın</h2>
  <dl class="kunye-dl">
    <dt>Yayın adı</dt>
    <dd>Gündem Türkiye 365</dd>
    <dt>Alan adı</dt>
    <dd><a href="https://www.gundemturkiye365.com/">www.gundemturkiye365.com</a></dd>
    <dt>Yayın türü</dt>
    <dd>
      Türkiye ve dünyadan güncel haber başlıkları ile özetlerin derlendiği; tam metin ve görsellerin ilgili
      kaynak sitelerde yer aldığı haber akışı ve bilgilendirme hizmeti.
    </dd>
  </dl>
  <h2>İletişim</h2>
  <dl class="kunye-dl">
    <dt>Genel ve teknik</dt>
    <dd><a href="mailto:contact@gundemturkiye365.com">contact@gundemturkiye365.com</a></dd>
    <dt>Editoryal ve kurumsal</dt>
    <dd><a href="mailto:info@gundemturkiye365.com">info@gundemturkiye365.com</a></dd>
  </dl>
  <p>
    Basın ve hukuk başvuruları, telif bildirimleri ile yayıncılıkla ilgili resmî yazışmalar için öncelikle
    <a href="mailto:info@gundemturkiye365.com">info@gundemturkiye365.com</a> adresine konu satırında konuyu
    belirterek e-posta gönderebilirsiniz.
  </p>
  <h2>Tasarım</h2>
  <p>
    Arayüz tasarımı <strong>Eviva Software</strong> tarafından yapılmıştır.
  </p>
  <h2>Telif ve kaynak</h2>
  <p>
    Haber metinleri ve görsellerin telif hakları ilgili ajans veya internet sitesine aittir; sitemiz özet ve
    yönlendirme sağlar. Ayrıntılı açıklama için <a href="#/hakkimizda">Hakkımızda</a> sayfasına bakınız.
  </p>
  <h2>İlgili metinler</h2>
  <p>
    <a href="#/gizlilik">Gizlilik</a> ·
    <a href="#/hizmet-sartlari">Hizmet Şartları</a> ·
    <a href="#/iletisim">İletişim</a>
  </p>
</article>`;

  const STATIC_CONTACT_HTML = `<article class="static-article">
  <h1>İletişim</h1>
  <p>
    Soru, öneri, teknik bildirim veya iş birliği talepleriniz için aşağıdaki adreslerden bize yazabilirsiniz.
    Mümkün olduğunca kısa sürede yanıt vermeye çalışırız.
  </p>
  <h2>E-posta</h2>
  <ul>
    <li>
      <a href="mailto:contact@gundemturkiye365.com">contact@gundemturkiye365.com</a>
      — genel iletişim, site ve teknik konular
    </li>
    <li>
      <a href="mailto:info@gundemturkiye365.com">info@gundemturkiye365.com</a>
      — editoryal konular, kurumsal iletişim ve <a href="#/reklam">reklam</a> talepleri
    </li>
  </ul>
  <h2>Site</h2>
  <p>
    Yayın politikamız ve site hakkında daha fazla bilgi için
    <a href="#/hakkimizda">Hakkımızda</a> sayfasına göz atabilirsiniz.
    Kişisel veriler için <a href="#/gizlilik">Gizlilik</a> metnine bakın.
    <a href="#/hizmet-sartlari">Hizmet Şartları</a> için ayrıca bakınız.
    <a href="#/kunye">Künye</a> sayfasına da göz atabilirsiniz.
  </p>
</article>`;

  const STATIC_PRIVACY_HTML = `<article class="static-article">
  <h1>Gizlilik</h1>
  <p>
    Bu metin, <strong>${BRAND_KICKER}</strong> sitesini ziyaret ettiğinizde kişisel verilerinizin nasıl
    işlenebileceğine dair genel bir açıklama sunar. Ayrıntılı hukuki talepler için
    <a href="mailto:contact@gundemturkiye365.com">contact@gundemturkiye365.com</a>
    adresine yazabilirsiniz.
  </p>
  <h2>Toplanan veriler</h2>
  <p>
    Haber özetleri ve görseller RSS veya kaynak siteler üzerinden sunucularımızda işlenir; siz yalnızca siteyi
    gezdiğinizde tarayıcınız teknik olarak IP adresiniz, tarayıcı türü ve benzeri standart günlük kayıtlarını
    barındırıcı (hosting) ortamında oluşturabilir. Bu kayıtların saklama süresi hizmet sağlayıcınızın
    politikasına bağlıdır.
  </p>
  <h2>Hava durumu ve yaklaşık konum</h2>
  <p>
    Ana sayfadaki hava özeti, tarayıcınızdan ayrıca konum izni istenmeden, isteğiniz sunucumuza ulaştığında
    görülebilen <strong>IP adresiniz</strong> üzerinden yürütülür. Sunucumuz, yaklaşık enlem ve boylam ile yer
    adı elde etmek için <strong>ipwho.is</strong> hizmetine; hava verisi için ise bu koordinatlarla
    <strong>Open-Meteo</strong> uç noktasına bağlanır. Veriler kısa süreli bellek önbelleğinde tutulabilir;
    cihazınızda hassas konum saklanmaz. Bu işleme, üçüncü tarafların kendi gizlilik ve kullanım koşulları da
    tabidir.
  </p>
  <h2>Akaryakıt fiyatları özeti</h2>
  <p>
    Akaryakıt modülünde il seçmediğinizde, varsayılan il tahmini yine <strong>IP adresiniz</strong> ile
    (ipwho.is) yapılabilir; dilerseniz listeyi kullanarak ili kendiniz seçersiniz. Fiyat verisi, EPDK bildirimlerine
    dayalı üçüncü taraf bir kaynak olan <strong>hasanadiguzel.com.tr</strong> üzerinden sunucumuz aracılığıyla
    alınır. Gösterilen rakamlar bilgilendirme amaçlıdır; istasyon veya anlık pompa fiyatıyla farklılık
    gösterebilir. İşlem kayıtları ve önbellekleme sunucu tarafında sınırlı tutulur.
  </p>
  <h2>Tarayıcıda saklanan bilgiler</h2>
  <p>
    Açık / koyu tema tercihiniz yalnızca cihazınızda, <code>localStorage</code> üzerinde tutulur; sunucuya
    gönderilmez. İsterseniz tarayıcı ayarlarından site verilerini silebilirsiniz.
  </p>
  <h2>Çerezler ve üçüncü taraflar</h2>
  <p>
    Sitede reklam veya davranışsal izleme çerezleri kullanılmamaktadır. Harici haber bağlantılarına tıkladığınızda
    o sitelerin kendi gizlilik uygulamaları geçerlidir. Hava ve akaryakıt modüllerinde anılan veri sağlayıcılarına
    erişim sunucumuz üzerinden yapılır; bu sağlayıcıların koşulları kendi yayınlarında düzenlenir.
  </p>
  <h2>Haklarınız</h2>
  <p>
    KVKK kapsamındaki başvuru ve taleplerinizi e-posta ile iletebilirsiniz. Başvurunuza makul sürede yanıt
    verilmesi hedeflenir.
  </p>
  <p>
    Siteyi kullanımınız <a href="#/hizmet-sartlari">Hizmet Şartları</a> ile de bağlantılıdır.
  </p>
</article>`;

  const STATIC_TERMS_HTML = `<article class="static-article">
  <h1>Hizmet Şartları</h1>
  <p>
    Bu metin, <strong>${BRAND_KICKER}</strong> web sitesini ve sunulan hizmetleri kullanırken geçerli olan
    kuralları özetler. Siteyi kullanmaya devam ederek bu şartları okuduğunuzu ve kabul ettiğinizi varsayarız.
    Şartlarda yapılacak güncellemeler bu sayfada yayımlanır; önemli değişikliklerde makul çerçevede site
    üzerinden bilgilendirme yapılabilir.
  </p>
  <h2>Hizmetin niteliği</h2>
  <p>
    Site; haber başlıkları, özetler ve üçüncü taraf kaynaklara bağlantılar sunan bir haber akışı ve bilgi
    aracıdır. Tam haber metinleri, görsellerin telif hakları ve içerik politikaları ilgili kaynak sitelere
    aittir. Biz, yalnızca derleme ve yönlendirme sağlarız; kaynak sitelerin içeriklerini kontrol etme veya
    garanti etme yükümlülüğümüz yoktur.
  </p>
  <h2>Hava durumu ve akaryakıt bilgileri</h2>
  <p>
    Sitede yer alan <strong>hava durumu</strong> ve <strong>akaryakıt fiyat özeti</strong> yalnızca genel
    bilgilendirme içindir; ticari teklif, profesyonel tavsiye veya resmi duyuru niteliği taşımaz. Hava verisi
    üçüncü taraf meteoroloji hizmetlerinden; akaryakıt verisi ise bildirimlere dayalı üçüncü taraf kaynaklardan
    derlenir ve gecikme, eksiklik veya teknik hata ihtimali daima vardır. Akaryakıt rakamları il veya bölge
    gruplarına göre özetlenebilir; <strong>belirli bir istasyondaki anlık fiyatı</strong> göstermeyebilir.
    Satın alma, seyahat veya hukuki işlem gibi sonuç doğuran kararlarda yalnızca bu siteye güvenilmemeli;
    resmi kurum, dağıtıcı veya istasyon bilgisi doğrulanmalıdır.
  </p>
  <h2>Kullanım kuralları</h2>
  <p>
    Siteyi yalnızca yürürlükteki mevzuata, üçüncü kişilerin haklarına ve bu şartlara uygun şekilde
    kullanmayı kabul edersiniz. Otomatik toplama (ör. aşırı istek, bot veya tarama araçları) ile hizmetin
    işleyişini bozmak, güvenliği tehdit etmek veya kaynakları kötüye kullanmak yasaktır.
  </p>
  <h2>Sorumluluk sınırı</h2>
  <p>
    Sunulan bilgiler &ldquo;olduğu gibi&rdquo; sağlanır. Teknik kesintiler, güncellenmemiş özetler veya
    harici sitelerdeki hatalı içeriklerden doğabilecek doğrudan veya dolaylı zararlardan sorumluluk kabul
    edilmez. Önemli kararlar için her zaman resmi kaynakları ve ilgili haber sitesini doğrudan incelemeniz
    önerilir.
  </p>
  <h2>Bağlantılar</h2>
  <p>
    Sitedeki dış bağlantılar yalnızca kolaylık içindir. Bağlantı verilen sitelerin gizlilik uygulamaları,
    içerikleri veya hizmet şartları bizim kontrolümüzde değildir.
  </p>
  <h2>Fikri mülkiyet</h2>
  <p>
    Sitenin tasarımı, yazılım düzeni ve marka unsurları (izin verilen ölçüde) ilgili hak sahiplerine
    aittir. İçerikleri izinsiz kopyalama, ticari yeniden kullanım veya otomatik yeniden yayımlama yasaktır.
  </p>
  <h2>İletişim ve uygulanacak hukuk</h2>
  <p>
    Bu şartlarla ilgili sorularınız için
    <a href="mailto:contact@gundemturkiye365.com">contact@gundemturkiye365.com</a>
    adresine yazabilirsiniz. Uyuşmazlıklarda Türkiye Cumhuriyeti kanunları uygulanır; yetkili mahkemeler
    ve icra mercileri Türkiye sınırları içindedir.
  </p>
  <p>
    Kişisel veriler için <a href="#/gizlilik">Gizlilik</a> sayfasına,
    genel bilgi için <a href="#/hakkimizda">Hakkımızda</a> sayfasına bakabilirsiniz.
  </p>
</article>`;

  const STATIC_FUEL_HTML = `<article class="static-article fuel-page">
  <h1>En düşük akaryakıt fiyatları</h1>
  <p class="fuel-lead">
    Kurşunsuz benzin ve motorin için seçtiğiniz ilde, EPDK’ya bildirilen bölge gruplarına göre bugünkü en düşük litre fiyatları.
    İstasyon bazında farklılık olabilir.
  </p>
  <div class="fuel-toolbar">
    <label for="fuel-city-select">İl</label>
    <select id="fuel-city-select" name="fuel-city" aria-describedby="fuel-panel">
      <option value="">Yükleniyor…</option>
    </select>
  </div>
  <div id="fuel-panel" class="pulse-skel" aria-live="polite">
    <div class="ui-sk ui-sk-line"></div>
    <div class="ui-sk ui-sk-line ui-sk-line--narrow"></div>
    <div class="ui-sk ui-sk-line ui-sk-line--short"></div>
  </div>
</article>`;

  const STATIC_ADS_HTML = `<article class="static-article">
  <h1>Reklam</h1>
  <p>
    <strong>${BRAND_KICKER}</strong> üzerinde markanızı veya kampanyanızı hedef kitleye duyurmak için reklam
    alanları ve sponsorluk modelleri sunulabilir. Editöryal haber akışı ile ticari mesajlar birbirinden açıkça
    ayrılır; sponsorlu içerik varsa okuyucuya net şekilde belirtilir.
  </p>
  <h2>Teklif ve iş birliği</h2>
  <p>
    Medya kiti, fiyatlandırma veya özel paket talepleriniz için lütfen
    <a href="mailto:info@gundemturkiye365.com?subject=Reklam%20%2F%20iş%20birliği%20talebi">info@gundemturkiye365.com</a>
    adresine e-posta gönderin. Mesajınızda marka adı, iletişim kişisi ve tercih ettiğiniz dönem / format
    (ör. manşet yanı, kategori sponsorluğu, dönemsel kampanya) gibi bilgileri paylaşmanız süreci hızlandırır.
  </p>
  <h2>İletişim</h2>
  <p>
    Genel site ve teknik konular için <a href="#/iletisim">İletişim</a> sayfasındaki
    <a href="mailto:contact@gundemturkiye365.com">contact</a> adresini kullanabilirsiniz.
  </p>
</article>`;

  const STATIC_PAGE_HTML = {
    about: STATIC_ABOUT_HTML,
    contact: STATIC_CONTACT_HTML,
    privacy: STATIC_PRIVACY_HTML,
    terms: STATIC_TERMS_HTML,
    fuel: STATIC_FUEL_HTML,
    ads: STATIC_ADS_HTML,
    kunye: STATIC_KUNYE_HTML,
  };

  const STATIC_PAGE_TITLE = {
    about: "Hakkımızda",
    contact: "İletişim",
    privacy: "Gizlilik",
    terms: "Hizmet Şartları",
    fuel: "En düşük akaryakıt fiyatları",
    ads: "Reklam",
    kunye: "Künye",
  };

  function isStaticContentView(view) {
    return (
      view === "about" ||
      view === "contact" ||
      view === "privacy" ||
      view === "terms" ||
      view === "fuel" ||
      view === "ads" ||
      view === "kunye"
    );
  }

  function isStaticContentRoute(route) {
    return isStaticContentView(route.view);
  }

  /** fetch(/api/news) sonrası gerçek API sunucusu (önizleyici / farklı port için şart) */
  let apiOrigin = "";

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function escapeAttr(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;");
  }

  /** Liste kartlarında tam özet yerine kısa teaser + tıklama çağrısı */
  function clipTeaser(s, maxLen) {
    const t = String(s || "")
      .trim()
      .replace(/\s+/g, " ");
    if (!t) return "";
    const m = Math.max(20, Number(maxLen) || 100);
    if (t.length <= m) return t;
    let cut = t.slice(0, m);
    const sp = cut.lastIndexOf(" ");
    if (sp > Math.floor(m * 0.52)) cut = cut.slice(0, sp);
    return cut.trim() + "…";
  }

  function teaserHtml(excerpt, maxLen) {
    const text = clipTeaser(excerpt, maxLen);
    if (!text) return "";
    return `<div class="card-teaser">
      <p class="excerpt">${esc(text)}</p>
      <span class="read-more">Devamını gör</span>
    </div>`;
  }

  function thumbProxySrc(item) {
    if (!item || !item.image) return "";
    const base = resolveApiOrigin().replace(/\/$/, "");
    let url = base + "/api/image?u=" + encodeURIComponent(item.image);
    if (item.link) {
      url += "&r=" + encodeURIComponent(item.link);
    }
    return url;
  }

  function formatAgo(ts) {
    if (!ts) return "";
    const sec = Math.floor((Date.now() - ts) / 1000);
    if (sec < 45) return "Az önce";
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} dk önce`;
    const hr = Math.floor(min / 60);
    if (hr < 36) return `${hr} saat önce`;
    const day = Math.floor(hr / 24);
    return `${day} gün önce`;
  }

  function setTopbarDate() {
    const el = document.getElementById("topbar-date");
    if (!el) return;
    const now = new Date();
    const city = "Ankara";
    el.textContent =
      now.toLocaleDateString("tr-TR", {
        day: "numeric",
        month: "long",
        year: "numeric",
      }) +
      " — " +
      city;
  }

  function skeletonBreakingHtml() {
    return `<span class="breaking-chunk breaking-chunk--sk" aria-hidden="true"><span class="ui-sk ui-sk-pill"></span><span class="ui-sk ui-sk-pill ui-sk-pill--short"></span></span>`;
  }

  function skeletonPulseBlockHtml(lines) {
    const n = Math.max(3, Number(lines) || 4);
    let h = `<div class="pulse-skel" aria-hidden="true">`;
    for (let i = 0; i < n; i++) {
      const narrow = i % 2 === 1 ? " ui-sk-line--narrow" : "";
      h += `<div class="ui-sk ui-sk-line${narrow}"></div>`;
    }
    h += `</div>`;
    return h;
  }

  function skeletonHeroMainHtml() {
    return `<div class="card card-hero card--sk" aria-hidden="true"><div class="thumb"><div class="ui-sk ui-sk-fill"></div></div><div class="card-body"><div class="ui-sk ui-sk-line ui-sk-line--xl"></div><div class="ui-sk ui-sk-line"></div><div class="ui-sk ui-sk-line"></div><div class="ui-sk ui-sk-line ui-sk-line--short"></div></div></div>`;
  }

  function skeletonHeroSideHtml() {
    const row = `<div class="card side-card card--sk" aria-hidden="true"><div class="thumb"><div class="ui-sk ui-sk-fill"></div></div><div class="card-body"><div class="ui-sk ui-sk-line ui-sk-line--lg"></div><div class="ui-sk ui-sk-line ui-sk-line--short"></div></div></div>`;
    return row + row;
  }

  function skeletonGridHtml(count) {
    const n = Math.min(12, Math.max(6, Number(count) || 9));
    let h = "";
    for (let i = 0; i < n; i++) {
      h += `<div class="card grid-card card--sk card--sk-grid" aria-hidden="true"><div class="thumb"><div class="ui-sk ui-sk-fill"></div></div><div class="card-body"><div class="ui-sk ui-sk-line ui-sk-line--lg"></div><div class="ui-sk ui-sk-line"></div><div class="ui-sk ui-sk-line ui-sk-line--short"></div></div></div>`;
    }
    return h;
  }

  function thumbHtml(item, opts) {
    const o = opts || {};
    const proxied = thumbProxySrc(item);
    const cls = "thumb" + (proxied ? " has-img" : "") + (o.extraClass ? " " + o.extraClass : "");
    const direct = item && item.image ? escapeAttr(item.image) : "";
    const imgEl = proxied
      ? `<img class="thumb-img" src="${escapeAttr(proxied)}"${
          direct ? ` data-direct="${direct}"` : ""
        } referrerpolicy="no-referrer" onerror="var d=this.dataset.direct;if(d){this.onerror=null;this.removeAttribute('data-direct');this.src=d;}" alt="" loading="lazy" decoding="async" />`
      : "";
    const badge = o.withBadge ? '<span class="thumb-badge">Gündem</span>' : "";
    return `<div class="${cls}">${imgEl}${badge}</div>`;
  }

  function resolveApiOrigin() {
    if (apiOrigin) return apiOrigin;
    if (SITE) return SITE;
    try {
      return new URL(window.location.href).origin;
    } catch {
      return "";
    }
  }

  function haberHref(item) {
    const id = (item && item.id) || "";
    const base = resolveApiOrigin().replace(/\/$/, "");
    if (!id) return base + "/";
    return base + "/haber/" + encodeURIComponent(id);
  }

  /** Sunucu HTML döndürdüyse (yanlış kök, Live Server) anlamlı hata */
  async function parseJsonResponse(res, label) {
    const text = await res.text();
    const t = text.trimStart();
    if (!t || t.startsWith("<")) {
      throw new Error(
        `${label}: JSON yerine HTML alındı. Sayfayı \`npm start\` ile aynı adresten açın veya ` +
          `<head> içindeki meta gundem365-api-origin / window.__GUNDEM365_SITE__ değerini API sunucunuza göre ayarlayın.`
      );
    }
    try {
      return JSON.parse(text);
    } catch (_e) {
      throw new Error(`${label}: Geçersiz JSON yanıtı.`);
    }
  }

  function captureApiOriginFromResponse(res) {
    try {
      if (res && res.url) apiOrigin = new URL(res.url).origin;
    } catch (_e) {}
    if (apiOrigin) return;
    try {
      const fallback = SITE ? SITE + "/api/news" : window.location.origin + "/api/news";
      apiOrigin = new URL(fallback, window.location.href).origin;
    } catch (_e2) {}
  }

  function heroCard(item) {
    if (!item) return "";
    const ago = formatAgo(item.ts);
    return `
      <a href="${haberHref(item)}" class="card-link card card-hero">
        ${thumbHtml(item, { withBadge: true })}
        <div class="card-body">
          <span class="kicker">${esc(BRAND_KICKER)}</span>
          <h2>${esc(item.title)}</h2>
          ${teaserHtml(item.excerpt, 118)}
          <div class="meta">${esc(ago)}</div>
        </div>
      </a>`;
  }

  function sideCard(item) {
    if (!item) return "";
    const ago = formatAgo(item.ts);
    return `
      <a href="${haberHref(item)}" class="card-link card side-card">
        ${thumbHtml(item)}
        <div class="card-body">
          <span class="kicker">${esc(BRAND_KICKER)}</span>
          <h3>${esc(item.title)}</h3>
          ${teaserHtml(item.excerpt, 82)}
          <div class="meta">${esc(ago)}</div>
        </div>
      </a>`;
  }

  function gridCard(item) {
    if (!item) return "";
    const ago = formatAgo(item.ts);
    return `
      <a href="${haberHref(item)}" class="card-link card grid-card">
        ${thumbHtml(item)}
        <div class="card-body">
          <span class="kicker">${esc(BRAND_KICKER)}</span>
          <h3>${esc(item.title)}</h3>
          ${teaserHtml(item.excerpt, 96)}
          <div class="meta">${esc(ago)}</div>
        </div>
      </a>`;
  }

  let allItems = [];

  const NAV_LABELS = {
    gundem: "Gündem",
    ekonomi: "Ekonomi",
    dunya: "Dünya",
    spor: "Spor",
    teknoloji: "Teknoloji",
    kultur: "Kültür",
    yasam: "Yaşam",
    video: "Video",
  };
  const NAV_SLUGS = Object.keys(NAV_LABELS);
  let activeCategory = "";
  /** Aynı statik sayfada <code>load()</code> tekrarlandığında içeriği baştan yazmayı önler (ör. akaryakıt paneli). */
  let staticShellInjectedView = "";

  function parseRouteFromHash() {
    const raw = (location.hash || "")
      .replace(/^#/, "")
      .replace(/^\//, "")
      .trim();
    const parts = raw.split("/").filter((p) => p.length);
    const head = (parts[0] || "").toLowerCase();
    if (head === "arsiv") {
      let page = 1;
      if (parts.length >= 2) {
        const n = parseInt(parts[1], 10);
        if (Number.isFinite(n) && n > 0) page = Math.min(Math.floor(n), 500000);
      }
      return { view: "archive", page, category: "", catPage: 1 };
    }
    if (head === "hakkimizda") {
      return { view: "about", page: 1, category: "", catPage: 1 };
    }
    if (head === "kunye") {
      return { view: "kunye", page: 1, category: "", catPage: 1 };
    }
    if (head === "iletisim") {
      return { view: "contact", page: 1, category: "", catPage: 1 };
    }
    if (head === "gizlilik") {
      return { view: "privacy", page: 1, category: "", catPage: 1 };
    }
    if (head === "hizmet-sartlari") {
      return { view: "terms", page: 1, category: "", catPage: 1 };
    }
    if (head === "akaryakit") {
      return { view: "fuel", page: 1, category: "", catPage: 1 };
    }
    if (head === "reklam") {
      return { view: "ads", page: 1, category: "", catPage: 1 };
    }
    if (NAV_SLUGS.includes(head)) {
      let catPage = 1;
      if (parts.length >= 2) {
        const n = parseInt(parts[1], 10);
        if (Number.isFinite(n) && n > 0) catPage = Math.min(Math.floor(n), 500000);
      }
      return { view: "category", page: 1, category: head, catPage };
    }
    return { view: "home", page: 1, category: "", catPage: 1 };
  }

  function setMainArchiveClass(on) {
    const main = document.getElementById("main-content");
    if (!main) return;
    main.classList.toggle("archive-view", !!on);
  }

  function setNavForRoute(route) {
    document.querySelectorAll(".nav-cat").forEach((a) => {
      const cat = a.getAttribute("data-category") || "";
      const on =
        (route.view === "home" && cat === "") ||
        (route.view === "category" && cat === route.category);
      a.classList.toggle("is-active", on);
      if (on) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    const ar = document.querySelector(".nav-arsiv");
    if (ar) {
      const on = route.view === "archive";
      ar.classList.toggle("is-active", on);
      if (on) ar.setAttribute("aria-current", "page");
      else ar.removeAttribute("aria-current");
    }
    const nf = document.querySelector(".nav-fuel");
    if (nf) {
      const on = route.view === "fuel";
      nf.classList.toggle("is-active", on);
      if (on) nf.setAttribute("aria-current", "page");
      else nf.removeAttribute("aria-current");
    }
  }

  function syncStaticShell(route) {
    const isStatic = isStaticContentRoute(route);
    document.body.classList.toggle("page-static", isStatic);
    const main = document.getElementById("main-content");
    if (main) main.classList.toggle("static-page-active", isStatic);
    const shell = document.getElementById("static-page");
    if (!shell) return;
    shell.classList.toggle("static-page--open", isStatic);
    shell.classList.toggle("static-page--fuel", isStatic && route.view === "fuel");
    shell.setAttribute("aria-hidden", isStatic ? "false" : "true");
    if (isStatic) {
      const sub = STATIC_PAGE_TITLE[route.view] || "";
      document.title = sub ? sub + " — " + SITE_TAB_TITLE : SITE_TAB_TITLE;
      const needInject = staticShellInjectedView !== route.view || !String(shell.innerHTML || "").trim();
      if (needInject) {
        shell.innerHTML = STATIC_PAGE_HTML[route.view] || "";
        staticShellInjectedView = route.view;
        if (route.view === "fuel") {
          requestAnimationFrame(() => {
            loadFuelPrices("");
          });
        }
      }
    } else {
      shell.innerHTML = "";
      staticShellInjectedView = "";
      document.title = SITE_TAB_TITLE;
    }
  }

  /**
   * @param {{ page: number, category: string | null }} opts category null = tüm arşiv
   */
  async function loadDbFeedPage(opts) {
    const page = Math.max(1, Number(opts && opts.page) || 1);
    const cat = opts && opts.category ? String(opts.category).trim() : "";
    const gridEl = document.getElementById("grid-gundem");
    const pagerEl = document.getElementById("archive-pager");
    if (gridEl) {
      gridEl.className = "grid-3";
      gridEl.innerHTML = skeletonGridHtml(9);
    }
    if (pagerEl) {
      pagerEl.hidden = true;
      pagerEl.innerHTML = "";
    }
    const base = resolveApiOrigin().replace(/\/$/, "");
    let url =
      base +
      "/api/news/archive?page=" +
      encodeURIComponent(String(page)) +
      "&limit=" +
      encodeURIComponent(String(ARCHIVE_PAGE_SIZE));
    if (cat) {
      url += "&category=" + encodeURIComponent(cat);
    }
    try {
      const res = await fetch(url);
      captureApiOriginFromResponse(res);
      if (!res.ok) {
        throw new Error((cat ? "Kategori" : "Arşiv") + " yanıtı: " + res.status);
      }
      const data = await parseJsonResponse(res, cat ? "Kategori arşivi API" : "Haber arşivi API");
      renderPagedDbFeed(data, cat ? "category" : "archive", cat);
    } catch (e) {
      if (gridEl) {
        gridEl.innerHTML = `<p class="inline-msg grid-full">${esc(e.message || "Liste yüklenemedi.")}</p>`;
      }
      if (pagerEl) {
        pagerEl.hidden = true;
        pagerEl.innerHTML = "";
      }
    }
  }

  function renderPagedDbFeed(data, mode, categorySlug) {
    const items = data.items || [];
    const page = Math.max(1, Number(data.page) || 1);
    const totalPages = Math.max(0, Number(data.totalPages) || 0);
    const total = Math.max(0, Number(data.total) || 0);
    const heroEl = document.getElementById("hero-main");
    const sideEl = document.getElementById("hero-side");
    const gridEl = document.getElementById("grid-gundem");
    const pagerEl = document.getElementById("archive-pager");
    const sec = document.getElementById("sec-gundem");
    const isArchive = mode === "archive";
    const catLabel = categorySlug ? NAV_LABELS[categorySlug] || categorySlug : "";

    startBreakingTicker(allItems);

    stopHomeSlider();
    if (heroEl) heroEl.innerHTML = "";
    if (sideEl) sideEl.innerHTML = "";

    if (data.dbDisabled) {
      if (sec) sec.textContent = isArchive ? "Haber arşivi" : catLabel;
      if (gridEl) {
        const msg =
          data.errors && data.errors[0] && data.errors[0].error
            ? String(data.errors[0].error)
            : "Veritabanı kullanılamıyor.";
        gridEl.innerHTML = `<p class="inline-msg grid-full">${esc(msg)}</p>`;
      }
      if (pagerEl) {
        pagerEl.hidden = true;
        pagerEl.innerHTML = "";
      }
      return;
    }

    if (sec) {
      if (isArchive) {
        sec.textContent =
          totalPages > 1
            ? `Haber arşivi · Sayfa ${page} / ${totalPages} (${total} kayıt)`
            : total > 0
              ? `Haber arşivi (${total} kayıt)`
              : "Haber arşivi";
      } else {
        sec.textContent =
          totalPages > 1
            ? `${catLabel} · Sayfa ${page} / ${totalPages} (${total} kayıt)`
            : total > 0
              ? `${catLabel} (${total} kayıt)`
              : catLabel;
      }
    }
    const emptyMsg = isArchive
      ? "Arşivde gösterilecek görseli olan haber yok. Görseller RSS veya kaynak sayfasından geldikçe burada listelenir."
      : "Bu kategoride görseli kayıtlı haber yok veya henüz birikmedi.";
    if (gridEl) {
      gridEl.innerHTML = items.length
        ? items.map(gridCard).join("")
        : `<p class="inline-msg grid-full">${esc(emptyMsg)}</p>`;
    }
    if (pagerEl && totalPages > 1) {
      let prevHref = null;
      let nextHref = null;
      if (isArchive) {
        prevHref = page <= 1 ? null : page === 2 ? "#/arsiv" : "#/arsiv/" + (page - 1);
        nextHref = page >= totalPages ? null : "#/arsiv/" + (page + 1);
      } else {
        const slug = categorySlug;
        prevHref = page <= 1 ? null : page === 2 ? "#/" + slug : "#/" + slug + "/" + (page - 1);
        nextHref = page >= totalPages ? null : "#/" + slug + "/" + (page + 1);
      }
      const prevEl = prevHref
        ? `<a href="${escapeAttr(prevHref)}">Önceki</a>`
        : `<a href="#" aria-disabled="true">Önceki</a>`;
      const nextEl = nextHref
        ? `<a href="${escapeAttr(nextHref)}">Sonraki</a>`
        : `<a href="#" aria-disabled="true">Sonraki</a>`;
      pagerEl.innerHTML =
        `${prevEl}<span class="pager-meta">Sayfa ${page} / ${totalPages}</span>${nextEl}`;
      pagerEl.hidden = false;
    } else if (pagerEl) {
      pagerEl.hidden = true;
      pagerEl.innerHTML = "";
    }
  }

  function updateSectionTitle() {
    const h = document.getElementById("sec-gundem");
    if (!h) return;
    if (!activeCategory) h.textContent = "Son haberler";
    else h.textContent = `${NAV_LABELS[activeCategory] || activeCategory} — son haberler`;
  }

  function getViewItems() {
    let list = !activeCategory
      ? allItems
      : allItems.filter((it) => (it.category || "gundem") === activeCategory);
    if (activeCategory && list.length > 1) {
      list = [...list].sort((a, b) => {
        const ai = String(a.image || "").trim() ? 1 : 0;
        const bi = String(b.image || "").trim() ? 1 : 0;
        if (bi !== ai) return bi - ai;
        return (Number(b.ts) || 0) - (Number(a.ts) || 0);
      });
    }
    return list;
  }

  /** Kaydırma bittiğinde okuma süresi (ms) */
  const BREAKING_DWELL_MS = 10000;
  /** Haber değişiminde soluk geçiş */
  const BREAKING_CROSSFADE_MS = 320;
  let breakingSeq = 0;
  let breakingWaitTimer = null;
  let breakingFallbackTimer = null;
  let breakingTickerItems = [];
  let breakingTickerIdx = 0;

  function breakingPrefersReducedMotion() {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (_e) {
      return false;
    }
  }

  function stopBreakingTicker() {
    breakingSeq++;
    if (breakingWaitTimer) {
      clearTimeout(breakingWaitTimer);
      breakingWaitTimer = null;
    }
    if (breakingFallbackTimer) {
      clearTimeout(breakingFallbackTimer);
      breakingFallbackTimer = null;
    }
    const inner = document.getElementById("breaking-marquee-inner");
    if (inner) {
      inner.classList.remove("breaking-marquee-inner--loop");
      inner.style.removeProperty("--breaking-loop-sec");
      inner.style.removeProperty("--breaking-loop-shift");
      if (typeof inner.getAnimations === "function") {
        inner.getAnimations().forEach((a) => a.cancel());
      }
      inner.querySelectorAll(".breaking-marquee-track").forEach((el) => {
        if (typeof el.getAnimations === "function") el.getAnimations().forEach((a) => a.cancel());
      });
    }
  }

  function breakingDelay(ms, seq) {
    const t0 = Date.now();
    return new Promise((resolve) => {
      function tick() {
        breakingWaitTimer = null;
        if (seq !== breakingSeq) {
          resolve();
          return;
        }
        if (Date.now() - t0 >= ms) {
          resolve();
          return;
        }
        breakingWaitTimer = setTimeout(tick, Math.min(200, Math.max(40, ms / 4)));
      }
      tick();
    });
  }

  function breakingSetHeadlineDom(index) {
    const link = document.getElementById("breaking-link");
    const inner = document.getElementById("breaking-marquee-inner");
    if (!link || !inner || !breakingTickerItems.length) return;
    const item = breakingTickerItems[index % breakingTickerItems.length];
    const rawTitle = String(item.title || "—").trim() || "—";
    inner.classList.remove("breaking-marquee-inner--loop");
    inner.style.removeProperty("--breaking-loop-sec");
    inner.style.removeProperty("--breaking-loop-shift");
    if (breakingPrefersReducedMotion()) {
      inner.innerHTML = `<span class="breaking-chunk breaking-chunk--wrap">${esc(rawTitle)}</span>`;
    } else {
      inner.innerHTML = `<span class="breaking-chunk">${esc(rawTitle)}</span>`;
    }
    link.setAttribute("href", haberHref(item));
    link.classList.remove("breaking-ticker-link--inactive");
  }

  /** scrollWidth mobilde sık sık yanlış; gizli ölçüm + karakter tahmini ile taşma kararı. */
  function breakingEstimatedTitleWiderThan(marquee, plainTitle, styleRoot) {
    const W = marquee.clientWidth;
    if (W <= 4) return false;
    try {
      const probe = document.createElement("span");
      probe.setAttribute("aria-hidden", "true");
      probe.className = "breaking-chunk";
      probe.style.cssText =
        "position:absolute;left:-99999px;top:0;white-space:nowrap;visibility:hidden;pointer-events:none;margin:0;padding-right:2.5rem";
      const chunk = styleRoot && styleRoot.querySelector ? styleRoot.querySelector(".breaking-chunk") : null;
      const cs = getComputedStyle(chunk || marquee);
      probe.style.font = cs.font;
      probe.style.fontSize = cs.fontSize;
      probe.style.fontFamily = cs.fontFamily;
      probe.style.fontWeight = cs.fontWeight;
      probe.style.fontStyle = cs.fontStyle;
      probe.style.letterSpacing = cs.letterSpacing;
      probe.textContent = plainTitle;
      document.body.appendChild(probe);
      const tw = probe.offsetWidth;
      probe.remove();
      const innerPadApprox = 32;
      return tw + innerPadApprox > W - 2;
    } catch (_e) {
      const vw = typeof window !== "undefined" && window.innerWidth ? window.innerWidth : 400;
      const guessChars = vw < 520 ? 22 : vw < 900 ? 38 : 88;
      return String(plainTitle).length >= guessChars;
    }
  }

  function breakingNeedsLoopMarquee(marquee, inner, plainTitle) {
    const W = marquee.clientWidth;
    const sw = inner.scrollWidth;
    const chunk = inner.querySelector(".breaking-chunk");
    if (sw > W + 4) return true;
    if (chunk && chunk.scrollWidth > W + 4) return true;
    return breakingEstimatedTitleWiderThan(marquee, plainTitle, inner);
  }

  /** Taşan metin: iki yarım döngü için aynı başlık + ayraç; süre metin uzunluğuna göre. */
  function breakingInstallLoopMarquee(inner, rawTitle) {
    const safe = esc(rawTitle);
    inner.classList.remove("breaking-marquee-inner--fade");
    inner.style.removeProperty("--breaking-loop-shift");
    inner.innerHTML =
      `<div class="breaking-marquee-track">` +
      `<span class="breaking-chunk">${safe}</span>` +
      `<span class="breaking-marquee-sep" aria-hidden="true">·</span>` +
      `<span class="breaking-chunk" aria-hidden="true">${safe}</span>` +
      `<span class="breaking-marquee-sep" aria-hidden="true">·</span>` +
      `</div>`;
    inner.classList.add("breaking-marquee-inner--loop");
    const track = inner.querySelector(".breaking-marquee-track");
    if (!track) return;
    void track.offsetWidth;
    const totalW = track.scrollWidth;
    const shiftPx = totalW / 2;
    const sec = Math.min(50, Math.max(10, shiftPx / 52));
    inner.style.setProperty("--breaking-loop-shift", `${shiftPx}px`);
    inner.style.setProperty("--breaking-loop-sec", `${sec}s`);
  }

  function breakingScrollOncePromise(seq) {
    return new Promise((resolve) => {
      if (seq !== breakingSeq) {
        resolve();
        return;
      }
      const inner = document.getElementById("breaking-marquee-inner");
      const marquee = inner && inner.closest(".breaking-marquee");
      if (!inner || !marquee) {
        resolve();
        return;
      }
      if (typeof inner.getAnimations === "function") {
        inner.getAnimations().forEach((a) => a.cancel());
      }
      inner.querySelectorAll(".breaking-marquee-track").forEach((el) => {
        if (typeof el.getAnimations === "function") el.getAnimations().forEach((a) => a.cancel());
      });
      inner.style.transform = "";
      inner.classList.remove("breaking-marquee-inner--loop");
      inner.style.removeProperty("--breaking-loop-sec");
      inner.style.removeProperty("--breaking-loop-shift");
      void inner.offsetWidth;

      if (breakingPrefersReducedMotion()) {
        resolve();
        return;
      }

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (seq !== breakingSeq) {
            resolve();
            return;
          }
          const innerEl = document.getElementById("breaking-marquee-inner");
          const mq = innerEl && innerEl.closest(".breaking-marquee");
          if (!innerEl || !mq) {
            resolve();
            return;
          }
          const item = breakingTickerItems[breakingTickerIdx % breakingTickerItems.length];
          const rawTitle = String(item && item.title ? item.title : "").trim() || "—";
          if (!breakingNeedsLoopMarquee(mq, innerEl, rawTitle)) {
            resolve();
            return;
          }
          breakingInstallLoopMarquee(innerEl, rawTitle);
          resolve();
        });
      });
    });
  }

  async function breakingCrossfadeNext(loopSeq) {
    const inner = document.getElementById("breaking-marquee-inner");
    if (!inner || loopSeq !== breakingSeq) return;
    inner.classList.remove("breaking-marquee-inner--loop");
    inner.style.removeProperty("--breaking-loop-sec");
    inner.style.removeProperty("--breaking-loop-shift");
    inner.querySelectorAll(".breaking-marquee-track").forEach((track) => {
      if (typeof track.getAnimations === "function") {
        track.getAnimations().forEach((a) => a.cancel());
      }
    });
    inner.classList.add("breaking-marquee-inner--fade");
    await breakingDelay(BREAKING_CROSSFADE_MS, loopSeq);
    if (loopSeq !== breakingSeq) return;
    breakingTickerIdx = (breakingTickerIdx + 1) % breakingTickerItems.length;
    breakingSetHeadlineDom(breakingTickerIdx);
    if (typeof inner.getAnimations === "function") {
      inner.getAnimations().forEach((a) => a.cancel());
    }
    inner.style.transform = "";
    void inner.offsetWidth;
    inner.classList.remove("breaking-marquee-inner--fade");
    await breakingDelay(48, loopSeq);
  }

  function breakingRunLoop(loopSeq) {
    (async () => {
      try {
        while (breakingTickerItems.length && loopSeq === breakingSeq) {
          breakingSetHeadlineDom(breakingTickerIdx);
          const inner = document.getElementById("breaking-marquee-inner");
          if (inner) inner.classList.remove("breaking-marquee-inner--fade");

          await breakingScrollOncePromise(loopSeq);
          if (loopSeq !== breakingSeq) break;

          await breakingDelay(BREAKING_DWELL_MS, loopSeq);
          if (loopSeq !== breakingSeq) break;

          if (breakingTickerItems.length < 2) {
            const el = document.getElementById("breaking-marquee-inner");
            if (el) {
              el.classList.remove("breaking-marquee-inner--loop");
              el.style.removeProperty("--breaking-loop-sec");
              el.style.removeProperty("--breaking-loop-shift");
              if (typeof el.getAnimations === "function") {
                el.getAnimations().forEach((a) => a.cancel());
              }
              el.querySelectorAll(".breaking-marquee-track").forEach((track) => {
                if (typeof track.getAnimations === "function") {
                  track.getAnimations().forEach((a) => a.cancel());
                }
              });
              el.style.transform = "";
              void el.offsetWidth;
            }
            continue;
          }

          await breakingCrossfadeNext(loopSeq);
          if (loopSeq !== breakingSeq) break;
        }
      } catch (_e) {}
    })();
  }

  function startBreakingTicker(items) {
    stopBreakingTicker();
    breakingTickerItems = (items || []).filter((it) => it && String(it.title || "").trim()).slice(0, 15);
    breakingTickerIdx = 0;
    const link = document.getElementById("breaking-link");
    const inner = document.getElementById("breaking-marquee-inner");
    if (!link || !inner) return;
    link.setAttribute("aria-busy", "false");

    if (!breakingTickerItems.length) {
      inner.innerHTML = `<span class="breaking-chunk">${esc("Şu an gösterilecek haber yok.")}</span>`;
      link.setAttribute("href", "/");
      link.classList.add("breaking-ticker-link--inactive");
      return;
    }

    const loopSeq = breakingSeq;
    breakingRunLoop(loopSeq);
  }

  function setBreakingStaticMessage(message) {
    stopBreakingTicker();
    breakingTickerItems = [];
    const link = document.getElementById("breaking-link");
    const inner = document.getElementById("breaking-marquee-inner");
    if (!inner || !link) return;
    link.setAttribute("aria-busy", "false");
    inner.classList.remove("breaking-marquee-inner--fade", "breaking-marquee-inner--loop");
    inner.style.removeProperty("--breaking-loop-sec");
    inner.style.removeProperty("--breaking-loop-shift");
    inner.style.transform = "";
    inner.innerHTML = `<span class="breaking-chunk">${esc(message)}</span>`;
    link.setAttribute("href", "/");
    link.classList.add("breaking-ticker-link--inactive");
  }

  function applyFilter(q) {
    const query = (q || "").trim().toLowerCase();
    const base = getViewItems();
    if (!query) return base;
    return base.filter(
      (it) =>
        (it.title && it.title.toLowerCase().includes(query)) ||
        (it.excerpt && it.excerpt.toLowerCase().includes(query))
    );
  }

  function formatQuakeWhen(iso) {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleString("tr-TR", { dateStyle: "short", timeStyle: "short" });
    } catch (_e) {
      return "";
    }
  }

  function stopHomeSlider() {
    if (homeSliderTimer) {
      clearInterval(homeSliderTimer);
      homeSliderTimer = null;
    }
  }

  function homeSliderPrefersReducedMotion() {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (_e) {
      return false;
    }
  }

  function homeSliderSlideHtml(item, idx, active) {
    if (!item) return "";
    const cls =
      "card-link card card-hero home-slide" + (active ? " home-slide--active" : "");
    const ago = formatAgo(item.ts);
    const href = escapeAttr(haberHref(item));
    return `<a href="${href}" class="${cls}" data-slider-i="${idx}" aria-hidden="${active ? "false" : "true"}" tabindex="${active ? "0" : "-1"}">
    ${thumbHtml(item, { withBadge: true })}
    <div class="card-body">
      <span class="kicker">${esc(BRAND_KICKER)}</span>
      <h2>${esc(item.title)}</h2>
      ${teaserHtml(item.excerpt, 118)}
      <div class="meta">${esc(ago)}</div>
    </div>
  </a>`;
  }

  function goHomeSliderSlide(track, dotRoot, idx) {
    if (!track || !dotRoot) return;
    const slides = track.querySelectorAll(".home-slide");
    const dots = dotRoot.querySelectorAll(".home-slider-dot");
    slides.forEach((el, j) => {
      const on = j === idx;
      el.classList.toggle("home-slide--active", on);
      el.setAttribute("aria-hidden", on ? "false" : "true");
      el.tabIndex = on ? 0 : -1;
    });
    dots.forEach((btn, j) => {
      const on = j === idx;
      btn.classList.toggle("home-slider-dot--active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  function armHomeSliderAutoplay(n) {
    stopHomeSlider();
    if (n < 2) return;
    if (homeSliderPrefersReducedMotion()) return;
    homeSliderTimer = setInterval(() => {
      const v = document.getElementById("home-slider-viewport");
      const d = document.getElementById("home-slider-dots");
      const t = v && v.querySelector(".home-slider-track");
      if (!t || !d) return;
      homeSliderIdx = (homeSliderIdx + 1) % n;
      goHomeSliderSlide(t, d, homeSliderIdx);
    }, HOME_SLIDER_MS);
  }

  function renderHomeSlider(items) {
    const heroMain = document.getElementById("hero-main");
    if (!heroMain) return;
    stopHomeSlider();
    const slice = (items || []).filter(Boolean).slice(0, HOME_SLIDER_MAX);
    if (!slice.length) {
      heroMain.innerHTML = skeletonHeroMainHtml();
      return;
    }
    homeSliderIdx = 0;
    const slidesHtml = slice.map((it, i) => homeSliderSlideHtml(it, i, i === 0)).join("");
    const dotsHtml = slice
      .map(
        (_, i) =>
          `<button type="button" class="home-slider-dot${i === 0 ? " home-slider-dot--active" : ""}" data-i="${i}" aria-label="Slayt ${i + 1}" aria-pressed="${i === 0 ? "true" : "false"}"></button>`
      )
      .join("");
    const navHidden = slice.length < 2 ? " hidden" : "";
    const iconPrev = `<svg class="home-slider-nav__icon" viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M14 7l-5 5 5 5" fill="none" stroke="currentColor" stroke-width="2.35" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    const iconNext = `<svg class="home-slider-nav__icon" viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M10 7l5 5-5 5" fill="none" stroke="currentColor" stroke-width="2.35" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    heroMain.innerHTML = `<div class="home-slider-in-hero" aria-roledescription="carousel" aria-label="Öne çıkan haberler">
  <div class="home-slider-viewport card" id="home-slider-viewport">
    <div class="home-slider-track">${slidesHtml}</div>
    <button type="button" class="home-slider-nav home-slider-nav--prev" id="home-slider-prev" aria-label="Önceki haber"${navHidden}>${iconPrev}</button>
    <button type="button" class="home-slider-nav home-slider-nav--next" id="home-slider-next" aria-label="Sonraki haber"${navHidden}>${iconNext}</button>
    <div class="home-slider-dots" id="home-slider-dots" role="group" aria-label="Slayt seçimi">${dotsHtml}</div>
  </div>
</div>`;
    const viewport = document.getElementById("home-slider-viewport");
    const dotRoot = document.getElementById("home-slider-dots");
    if (!viewport || !dotRoot) return;
    const track = viewport.querySelector(".home-slider-track");
    dotRoot.querySelectorAll(".home-slider-dot").forEach((btn) => {
      btn.addEventListener("click", () => {
        const j = Number(btn.getAttribute("data-i")) || 0;
        homeSliderIdx = j;
        if (track) goHomeSliderSlide(track, dotRoot, homeSliderIdx);
        armHomeSliderAutoplay(slice.length);
      });
    });
    const prevBtn = document.getElementById("home-slider-prev");
    const nextBtn = document.getElementById("home-slider-next");
    const nSlides = slice.length;
    if (prevBtn && nextBtn && nSlides >= 2) {
      prevBtn.addEventListener("click", () => {
        homeSliderIdx = (homeSliderIdx - 1 + nSlides) % nSlides;
        if (track) goHomeSliderSlide(track, dotRoot, homeSliderIdx);
        armHomeSliderAutoplay(nSlides);
      });
      nextBtn.addEventListener("click", () => {
        homeSliderIdx = (homeSliderIdx + 1) % nSlides;
        if (track) goHomeSliderSlide(track, dotRoot, homeSliderIdx);
        armHomeSliderAutoplay(nSlides);
      });
    }
    if (track) {
      goHomeSliderSlide(track, dotRoot, 0);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          track.classList.add("home-slider-track--ready");
        });
      });
    }
    armHomeSliderAutoplay(slice.length);
  }

  function svgFxArrowUp() {
    return `<svg class="pulse-fx-ico" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M12 4l8 10H4l8-10z" fill="currentColor"/></svg>`;
  }

  function svgFxArrowDown() {
    return `<svg class="pulse-fx-ico" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M12 20l8-10H4l8 10z" fill="currentColor"/></svg>`;
  }

  function fmtFxPctTr(c) {
    const n = Number(c);
    if (!Number.isFinite(n)) return "—";
    const abs = Math.abs(n).toLocaleString("tr-TR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    if (n > 0) return "+" + abs + "%";
    if (n < 0) return "−" + abs + "%";
    return abs + "%";
  }

  function buildFxDeltaHtml(change, labelShort) {
    const c = change != null && Number.isFinite(Number(change)) ? Number(change) : null;
    if (c == null) {
      return `<span class="pulse-fx-delta pulse-fx-delta--na" title="${esc(
        labelShort + " günlük değişim verisi yok"
      )}">—</span>`;
    }
    const variant = c > 0 ? "up" : c < 0 ? "down" : "flat";
    const icon =
      c > 0
        ? svgFxArrowUp()
        : c < 0
          ? svgFxArrowDown()
          : `<svg class="pulse-fx-ico" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><rect x="5" y="11" width="14" height="2" rx="1" fill="currentColor"/></svg>`;
    const t = fmtFxPctTr(c);
    return `<span class="pulse-fx-delta pulse-fx-delta--${variant}" title="${esc(
      labelShort + " günlük değişim: " + t
    )}">${icon}<span class="pulse-fx-delta-txt">${esc(t)}</span></span>`;
  }

  function buildFxPanelHtml(fx) {
    const usd = Number.isFinite(fx.usd) ? fx.usd.toFixed(4) : "—";
    const eur = Number.isFinite(fx.eur) ? fx.eur.toFixed(4) : "—";
    const gold = Number.isFinite(fx.gold)
      ? fx.gold.toLocaleString("tr-TR", { maximumFractionDigits: 2, minimumFractionDigits: 2 })
      : "—";
    const dateLine = fx.date ? esc(String(fx.date)) : "";
    return (
      `<div class="pulse-fx-wrap">` +
      `<div class="pulse-fx-row"><span class="pulse-fx-pair">USD/TRY</span><strong class="pulse-fx-num">${esc(
        usd
      )}</strong>${buildFxDeltaHtml(fx.usdChange, "USD/TRY")}</div>` +
      `<div class="pulse-fx-row"><span class="pulse-fx-pair">EUR/TRY</span><strong class="pulse-fx-num">${esc(
        eur
      )}</strong>${buildFxDeltaHtml(fx.eurChange, "EUR/TRY")}</div>` +
      `<div class="pulse-fx-row"><span class="pulse-fx-pair">Gram altın</span><strong class="pulse-fx-num">${esc(
        gold
      )}</strong><span class="pulse-fx-hint"> TL (satış)</span> ${buildFxDeltaHtml(
        fx.goldChange,
        "Gram altın"
      )}</div>` +
      (dateLine ? `<p class="pulse-fx-meta">${dateLine}</p>` : "") +
      `</div>`
    );
  }

  function triggerFxDeltaFlash(container) {
    if (!container) return;
    container.querySelectorAll(".pulse-fx-delta").forEach((el) => {
      el.classList.remove("pulse-fx-delta--flash");
    });
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        container.querySelectorAll(".pulse-fx-delta").forEach((el) => {
          if (el.classList.contains("pulse-fx-delta--na")) return;
          void el.offsetWidth;
          el.classList.add("pulse-fx-delta--flash");
          el.addEventListener(
            "animationend",
            () => {
              el.classList.remove("pulse-fx-delta--flash");
            },
            { once: true }
          );
        });
      });
    });
  }

  function mountFxPanel(elFx, fx) {
    if (!elFx || !fx) return;
    elFx.innerHTML = buildFxPanelHtml(fx);
    triggerFxDeltaFlash(elFx);
  }

  async function refreshFxPanel() {
    try {
      const base = resolveApiOrigin().replace(/\/$/, "");
      const pr = await fetch(`${base}/api/tr-pulse?_=${Date.now()}`, { cache: "no-store" });
      if (!pr.ok) return;
      const pulseData = await parseJsonResponse(pr, "TR veri API (döviz)");
      renderPulseEarthquakesOnly(pulseData);
      const elFx = document.getElementById("pulse-fx");
      const fx = pulseData && pulseData.fx;
      if (
        elFx &&
        fx &&
        (Number.isFinite(fx.usd) || Number.isFinite(fx.eur) || Number.isFinite(fx.gold))
      ) {
        mountFxPanel(elFx, fx);
      }
    } catch (_e) {}
  }

  function formatWeatherTime(iso) {
    if (!iso) return "";
    const raw = String(iso).trim();
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleString("tr-TR", { dateStyle: "short", timeStyle: "short" });
    }
    return raw;
  }

  function weatherSymbol(cur) {
    const code = Number(cur && cur.weatherCode);
    const wind = Number(cur && cur.windKmh);
    const isDay = !!(cur && cur.isDay);
    if (Number.isFinite(wind) && wind >= 35) return "💨";
    if (Number.isFinite(code)) {
      if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82) || (code >= 51 && code <= 57))
        return "🌧️";
      if (code >= 71 && code <= 77) return "❄️";
      if (code === 0) return isDay ? "☀️" : "🌙";
      if (code >= 1 && code <= 3) return isDay ? "🌤️" : "☁️";
      if (code >= 95 && code <= 99) return "⛈️";
    }
    return "🌤️";
  }

  function buildWeatherPanelHtml(w) {
    if (!w || w.ok === false) {
      const msg = w && w.error ? String(w.error) : "Hava durumu yüklenemedi.";
      return `<p class="pulse-empty">${esc(msg)}</p>`;
    }
    const loc = w.location || {};
    const parts = [loc.city, loc.region].filter(Boolean);
    const line1 = parts.length ? parts.join(", ") : loc.country || "Konum";
    const approx = loc.approximate ? " · yaklaşık" : "";
    const cur = w.current || {};
    const temp = Number.isFinite(cur.tempC)
      ? Math.round(cur.tempC).toLocaleString("tr-TR")
      : "—";
    const wind = Number.isFinite(cur.windKmh)
      ? `${Math.round(cur.windKmh).toLocaleString("tr-TR")} km/s`
      : "—";
    const timeDisp = formatWeatherTime(cur.time);
    const timeLine = timeDisp ? ` · ${timeDisp}` : "";
    const weatherIcon = weatherSymbol(cur);
    return (
      `<div class="pulse-weather-wrap">` +
      `<p class="pulse-weather-loc">${esc(line1)}${esc(approx)}</p>` +
      `<p class="pulse-weather-temp"><span class="pulse-weather-deg">${esc(temp)}</span><span class="pulse-weather-unit">°C</span></p>` +
      `<p class="pulse-weather-desc"><span class="pulse-weather-icon" aria-hidden="true">${esc(weatherIcon)}</span>${esc(cur.summaryTr || "—")}</p>` +
      `<p class="pulse-weather-meta">Rüzgar: ${esc(wind)}${esc(timeLine)}</p>` +
      `</div>`
    );
  }

  function renderWeather(w, opts) {
    const emptyAll = !!(opts && opts.emptyAll);
    const elW = document.getElementById("pulse-weather");
    if (!elW) return;
    elW.classList.remove("pulse-skel");
    elW.removeAttribute("aria-hidden");
    if (!w || w.ok === false) {
      const msg = emptyAll
        ? "Türkiye verisi yüklenemedi (sunucu veya ağ)."
        : w && w.error
          ? String(w.error)
          : "Hava verisi alınamadı.";
      elW.innerHTML = `<p class="pulse-empty">${esc(msg)}</p>`;
      return;
    }
    elW.innerHTML = buildWeatherPanelHtml(w);
  }

  async function fetchWeatherPayload(base) {
    const root = String(base || "").replace(/\/$/, "");
    try {
      const r = await fetch(root + "/api/weather");
      return await parseJsonResponse(r, "Hava API");
    } catch (pe) {
      return { v: 1, ok: false, error: pe.message || String(pe) };
    }
  }

  async function refreshWeatherPanel() {
    if (document.visibilityState === "hidden") return;
    try {
      const base = resolveApiOrigin().replace(/\/$/, "");
      const w = await fetchWeatherPayload(base);
      renderWeather(w, { emptyAll: false });
    } catch (_e) {}
  }

  function fmtFuelLiraTr(n) {
    if (!Number.isFinite(n)) return "—";
    return n.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fuelDistrictLabel(k) {
    return String(k || "").replace(/,/g, " · ");
  }

  function populateFuelCitySelect(cities, currentToken) {
    const sel = document.getElementById("fuel-city-select");
    if (!sel || !Array.isArray(cities) || !cities.length) return;
    const sorted = cities.slice().sort((a, b) => String(a).localeCompare(String(b), "tr"));
    const want = String(currentToken || sel.value || "").trim();
    sel.innerHTML = sorted
      .map((c) => {
        const t = String(c);
        const lab = t.charAt(0) + t.slice(1).toLocaleLowerCase("tr-TR");
        const selAttr = t === want ? " selected" : "";
        return `<option value="${esc(t)}"${selAttr}>${esc(lab)}</option>`;
      })
      .join("");
  }

  function renderFuelPanel(data) {
    const panel = document.getElementById("fuel-panel");
    if (!panel) return;
    panel.classList.remove("pulse-skel");
    if (!data || data.ok === false) {
      const msg = data && data.error ? String(data.error) : "Akaryakıt verisi yüklenemedi.";
      panel.innerHTML = `<p class="pulse-empty">${esc(msg)}</p>`;
      if (data && Array.isArray(data.cities) && data.cities.length) {
        populateFuelCitySelect(data.cities, "");
      }
      return;
    }
    populateFuelCitySelect(data.cities, data.cityToken);
    const s = data.summary || {};
    const tm = data.tables && data.tables.motorin ? data.tables.motorin : [];
    const tb = data.tables && data.tables.benzin ? data.tables.benzin : [];
    const hint = data.note ? `<p class="fuel-note">${esc(data.note)}</p>` : "";
    const src = data.sourceUrl
      ? `<p class="fuel-source">Kaynak: <a href="${esc(data.sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(
          data.source || "Veri sağlayıcı"
        )}</a></p>`
      : "";
    const high =
      `<div class="fuel-highlight">` +
      `<span class="fuel-highlight-item"><strong>${esc(data.cityLabel || data.cityToken)}</strong> — Motorinde en düşük: <strong>${esc(
        fmtFuelLiraTr(s.minMotorinL)
      )}</strong> TL/lt</span>` +
      `<span class="fuel-highlight-item">Kurşunsuzda en düşük: <strong>${esc(fmtFuelLiraTr(s.minBenzinL))}</strong> TL/lt</span>` +
      `<span class="fuel-highlight-item">${esc(String(s.districtGroups || 0))} bölge grubu</span>` +
      `</div>`;
    const tableM =
      `<div class="fuel-table-wrap"><table class="fuel-table" aria-label="En düşük motorin bölgeleri"><thead><tr><th>Bölge kodu</th><th>Motorin (TL/lt)</th><th>Kurşunsuz (TL/lt)</th></tr></thead><tbody>` +
      tm
        .map((row) => {
          return `<tr><td>${esc(fuelDistrictLabel(row.districtKey))}</td><td>${esc(fmtFuelLiraTr(row.motorin))}</td><td>${esc(
            Number.isFinite(row.benzin) ? fmtFuelLiraTr(row.benzin) : "—"
          )}</td></tr>`;
        })
        .join("") +
      `</tbody></table></div>`;
    const tableB =
      tb.length && tb.some((r) => Number.isFinite(r.benzin))
        ? `<div class="fuel-table-wrap"><table class="fuel-table" aria-label="En düşük kurşunsuz bölgeleri"><thead><tr><th>Bölge kodu</th><th>Kurşunsuz (TL/lt)</th><th>Motorin (TL/lt)</th></tr></thead><tbody>` +
          tb
            .map((row) => {
              return `<tr><td>${esc(fuelDistrictLabel(row.districtKey))}</td><td>${esc(fmtFuelLiraTr(row.benzin))}</td><td>${esc(
                fmtFuelLiraTr(row.motorin)
              )}</td></tr>`;
            })
            .join("") +
          `</tbody></table></div>`
        : "";
    panel.innerHTML = high + tableM + tableB + hint + src;
  }

  async function fetchFuelPrices(base, cityToken) {
    const root = String(base || "").replace(/\/$/, "");
    const q = cityToken ? `?city=${encodeURIComponent(cityToken)}` : "";
    try {
      const r = await fetch(root + "/api/fuel-prices" + q);
      return await parseJsonResponse(r, "Akaryakıt API");
    } catch (pe) {
      return { v: 1, ok: false, error: pe.message || String(pe), cities: [] };
    }
  }

  async function loadFuelPrices(cityToken) {
    const base = resolveApiOrigin().replace(/\/$/, "");
    const data = await fetchFuelPrices(base, cityToken || "");
    renderFuelPanel(data);
  }

  let fuelDelegationBound = false;
  function ensureFuelChangeDelegation() {
    if (fuelDelegationBound) return;
    fuelDelegationBound = true;
    document.body.addEventListener("change", (e) => {
      const t = e.target;
      if (!t || t.id !== "fuel-city-select") return;
      const v = String(t.value || "").trim();
      if (v) loadFuelPrices(v);
    });
  }

  let fuelPollTimer = null;
  function ensureFuelPollInterval() {
    if (fuelPollTimer != null) return;
    fuelPollTimer = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      const s = document.getElementById("fuel-city-select");
      if (!s) return;
      const v = String(s.value || "").trim();
      loadFuelPrices(v);
    }, 7200000);
  }

  function renderPulseEarthquakesOnly(pulse) {
    const elQ = document.getElementById("pulse-quakes");
    if (!elQ) return;
    elQ.classList.remove("pulse-skel");
    elQ.removeAttribute("aria-hidden");
    if (!pulse) {
      elQ.innerHTML = `<p class="pulse-empty">${esc("Türkiye verisi yüklenemedi (sunucu veya ağ).")}</p>`;
      return;
    }
    const rows = Array.isArray(pulse.earthquakes) ? pulse.earthquakes.slice(0, PULSE_QUAKE_SHOW) : [];
    if (!rows.length) {
      const fromErr =
        pulse && Array.isArray(pulse.errors)
          ? pulse.errors
              .map((e) => (e && e.error ? String(e.error) : ""))
              .filter(Boolean)
              .join(" ")
          : "";
      const hint = fromErr || "Gösterilecek deprem kaydı yok.";
      elQ.innerHTML = `<p class="pulse-empty">${esc(hint)}</p>`;
      return;
    }
    elQ.innerHTML =
      '<ul class="pulse-list">' +
      rows
        .map((q) => {
          const mag = q.mag != null && Number.isFinite(Number(q.mag)) ? Number(q.mag).toFixed(1) : "—";
          const when = formatQuakeWhen(q.date);
          return `<li><span class="pulse-mag">${esc(mag)}</span><span class="pulse-place">${esc(
            q.place || "—"
          )}</span><span class="pulse-when">${esc(when)}</span></li>`;
        })
        .join("") +
      "</ul>";
  }

  function renderPulse(pulse) {
    const elQ = document.getElementById("pulse-quakes");
    const elFx = document.getElementById("pulse-fx");
    if (!elQ && !elFx) return;
    if (elQ) {
      elQ.classList.remove("pulse-skel");
      elQ.removeAttribute("aria-hidden");
    }
    if (elFx) {
      elFx.classList.remove("pulse-skel");
      elFx.removeAttribute("aria-hidden");
    }
    if (!pulse) {
      const fail = "Türkiye verisi yüklenemedi (sunucu veya ağ).";
      if (elQ) elQ.innerHTML = `<p class="pulse-empty">${esc(fail)}</p>`;
      if (elFx) elFx.innerHTML = `<p class="pulse-empty">${esc(fail)}</p>`;
      return;
    }
    renderPulseEarthquakesOnly(pulse);
    if (elFx) {
      const fx = pulse && pulse.fx;
      if (
        fx &&
        (Number.isFinite(fx.usd) || Number.isFinite(fx.eur) || Number.isFinite(fx.gold))
      ) {
        mountFxPanel(elFx, fx);
      } else {
        const fxErr =
          pulse && Array.isArray(pulse.errors)
            ? pulse.errors
                .filter((e) => e && e.source === "fx")
                .map((e) => e.error)
                .join(" ")
            : "";
        const hint = fxErr || (pulse && pulse.fxNote) || "Döviz verisi yüklenemedi; ağı veya servisi kontrol edin.";
        elFx.innerHTML = `<p class="pulse-empty">${esc(hint)}</p>`;
      }
    }
  }

  function render(items) {
    document.title = SITE_TAB_TITLE;
    const pagerEl = document.getElementById("archive-pager");
    if (pagerEl) {
      pagerEl.hidden = true;
      pagerEl.innerHTML = "";
    }
    setMainArchiveClass(false);

    const sideEl = document.getElementById("hero-side");
    const gridEl = document.getElementById("grid-gundem");

    startBreakingTicker(allItems);

    if (sideEl) {
      const side = items.slice(1, 3).map(sideCard).join("");
      sideEl.innerHTML = side || '<p class="inline-msg">Yan haber yok.</p>';
    }
    const rest = items.slice(3, 15);
    if (gridEl) {
      gridEl.innerHTML = rest.length
        ? rest.map(gridCard).join("")
        : "<p class=\"inline-msg grid-full\">Liste boş.</p>";
    }
    renderHomeSlider(items);
    updateSectionTitle();
  }

  function renderLoading() {
    stopHomeSlider();
    stopBreakingTicker();
    breakingTickerItems = [];
    const link = document.getElementById("breaking-link");
    const inner = document.getElementById("breaking-marquee-inner");
    if (inner) {
      inner.classList.remove("breaking-marquee-inner--run", "breaking-marquee-inner--loop");
      inner.style.removeProperty("--breaking-loop-sec");
      inner.style.removeProperty("--breaking-loop-shift");
      inner.style.setProperty("--breaking-marquee-sec", "0s");
      inner.innerHTML = skeletonBreakingHtml();
    }
    if (link) {
      link.setAttribute("href", "/");
      link.classList.add("breaking-ticker-link--inactive");
      link.setAttribute("aria-busy", "true");
    }
    const hm = document.getElementById("hero-main");
    if (hm) hm.innerHTML = skeletonHeroMainHtml();
    const hs = document.getElementById("hero-side");
    if (hs) hs.innerHTML = skeletonHeroSideHtml();
    const grid = document.getElementById("grid-gundem");
    if (grid) {
      grid.className = "grid-3";
      grid.innerHTML = skeletonGridHtml(9);
    }
    const elQ = document.getElementById("pulse-quakes");
    const elFx = document.getElementById("pulse-fx");
    const elW = document.getElementById("pulse-weather");
    if (elQ) elQ.innerHTML = skeletonPulseBlockHtml(PULSE_QUAKE_SHOW);
    if (elFx) elFx.innerHTML = skeletonPulseBlockHtml(4);
    if (elW) elW.innerHTML = skeletonPulseBlockHtml(3);
  }

  async function fetchTrPulsePayload(base) {
    const root = String(base || "").replace(/\/$/, "");
    try {
      const pr = await fetch(`${root}/api/tr-pulse?_=${Date.now()}`, { cache: "no-store" });
      if (pr.ok) {
        return await parseJsonResponse(pr, "TR veri API");
      }
      let extra = "";
      try {
        extra = (await pr.text()).slice(0, 200);
      } catch (_e) {}
      return {
        v: 1,
        earthquakes: [],
        fx: null,
        fxNote: null,
        errors: [{ source: "http", error: `TR veri uç noktası ${pr.status}. ${extra}` }],
        fetchedAt: new Date().toISOString(),
      };
    } catch (pe) {
      return {
        v: 1,
        earthquakes: [],
        fx: null,
        fxNote: null,
        errors: [{ source: "ağ", error: pe.message || String(pe) }],
        fetchedAt: new Date().toISOString(),
      };
    }
  }

  async function load(opts) {
    const silent = !!(opts && opts.silent);
    if (!silent) renderLoading();
    const base = resolveApiOrigin().replace(/\/$/, "");
    try {
      const res = await fetch(API);
      captureApiOriginFromResponse(res);
      if (!res.ok) {
        throw new Error("API yanıtı: " + res.status);
      }

      if (!silent) {
        const pulseApplyId = trPulseRenderGeneration;
        Promise.all([fetchTrPulsePayload(base), fetchWeatherPayload(base)]).then(([p, w]) => {
          if (pulseApplyId !== trPulseRenderGeneration) return;
          renderPulse(p);
          renderWeather(w, { emptyAll: false });
        });
      }

      const data = await parseJsonResponse(res, "Haber API");

      allItems = data.items || [];
      const route = parseRouteFromHash();
      activeCategory = route.view === "category" ? route.category : "";
      setMainArchiveClass(route.view === "archive" || route.view === "category");
      setNavForRoute(route);
      syncStaticShell(route);

      if (isStaticContentRoute(route)) {
        return;
      }

      if (route.view === "archive") {
        if (!silent) {
          await loadDbFeedPage({ page: route.page, category: null });
        }
      } else if (route.view === "category") {
        if (!silent) {
          await loadDbFeedPage({ page: route.catPage, category: route.category });
        }
      } else {
        render(applyFilter(document.getElementById("search-input")?.value || ""));
      }
    } catch (e) {
      trPulseRenderGeneration++;
      if (!silent) {
        allItems = [];
        const route = parseRouteFromHash();
        syncStaticShell(route);
        if (isStaticContentRoute(route)) {
          renderPulse(null);
          renderWeather(null, { emptyAll: true });
          setBreakingStaticMessage(
            "Haber akışı şu an yüklenemiyor; sayfa içeriğine yine de göz atabilirsiniz."
          );
          return;
        }
        render([]);
        renderPulse(null);
        renderWeather(null, { emptyAll: true });
        setBreakingStaticMessage(
          "Sunucuya bağlanılamadı. `npm start` ile projeyi çalıştırdığınızdan emin olun."
        );
      }
    }
  }

  const THEME_KEY = "gundem365-theme";

  function getTheme() {
    return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
  }

  function applyThemeToggleUi() {
    const btn = document.getElementById("theme-toggle");
    const light = getTheme() === "light";
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "theme-color");
      document.head.appendChild(meta);
    }
    meta.setAttribute("content", light ? "#eef1f7" : "#0a0d12");
    if (!btn) return;
    btn.setAttribute("aria-pressed", light ? "true" : "false");
    btn.setAttribute("title", light ? "Koyu temaya geç" : "Açık temaya geç");
    const lab = btn.querySelector(".theme-toggle__label");
    if (lab) lab.textContent = light ? "Koyu tema" : "Açık tema";
    const ic = btn.querySelector(".theme-toggle__icon");
    if (ic) ic.textContent = light ? "☾" : "☀";
  }

  function setTheme(mode) {
    if (mode === "light") {
      document.documentElement.setAttribute("data-theme", "light");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
    try {
      localStorage.setItem(THEME_KEY, mode === "light" ? "light" : "dark");
      localStorage.removeItem("gundem360-theme");
    } catch (_e) {}
    applyThemeToggleUi();
  }

  document.addEventListener("DOMContentLoaded", () => {
    setTopbarDate();
    applyThemeToggleUi();
    document.getElementById("theme-toggle")?.addEventListener("click", () => {
      setTheme(getTheme() === "light" ? "dark" : "light");
    });
    const initialRoute = parseRouteFromHash();
    activeCategory = initialRoute.view === "category" ? initialRoute.category : "";
    setMainArchiveClass(initialRoute.view === "archive" || initialRoute.view === "category");
    setNavForRoute(initialRoute);
    syncStaticShell(initialRoute);
    if (initialRoute.view === "archive") {
      const h = document.getElementById("sec-gundem");
      if (h) h.textContent = "Haber arşivi";
    } else if (initialRoute.view === "category") {
      const h = document.getElementById("sec-gundem");
      if (h) h.textContent = NAV_LABELS[initialRoute.category] || initialRoute.category;
    } else {
      updateSectionTitle();
    }

    window.addEventListener("hashchange", () => {
      const route = parseRouteFromHash();
      activeCategory = route.view === "category" ? route.category : "";
      setMainArchiveClass(route.view === "archive" || route.view === "category");
      setNavForRoute(route);
      syncStaticShell(route);
      if (route.view === "archive") {
        loadDbFeedPage({ page: route.page, category: null });
      } else if (route.view === "category") {
        loadDbFeedPage({ page: route.catPage, category: route.category });
      } else if (isStaticContentRoute(route)) {
        /* içerik syncStaticShell ile; haber listesi ayrıca güncellenmez */
      } else {
        render(applyFilter(document.getElementById("search-input")?.value || ""));
      }
    });

    document.querySelectorAll(".nav-cat").forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const cat = a.getAttribute("data-category") || "";
        const want = cat ? `#/${cat}` : `#/`;
        if (location.hash === want) {
          const v = parseRouteFromHash().view;
          if (v !== "archive" && v !== "category" && !isStaticContentView(v)) {
            render(applyFilter(document.getElementById("search-input")?.value || ""));
          }
          return;
        }
        location.hash = want;
      });
    });

    const search = document.getElementById("search-input");
    ensureFuelChangeDelegation();
    ensureFuelPollInterval();
    load();
    setInterval(() => load({ silent: true }), NEWS_POLL_MS);
    setInterval(() => {
      refreshFxPanel();
    }, FX_POLL_MS);
    setInterval(() => {
      refreshWeatherPanel();
    }, WEATHER_POLL_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      refreshFxPanel();
      refreshWeatherPanel();
    });
    window.addEventListener("pageshow", (ev) => {
      if (ev.persisted) {
        refreshFxPanel();
        refreshWeatherPanel();
      }
    });
    if (search) {
      let t;
      search.addEventListener("input", () => {
        clearTimeout(t);
        t = setTimeout(() => {
          const hv = parseRouteFromHash().view;
          if (hv === "archive" || hv === "category" || isStaticContentView(hv)) return;
          render(applyFilter(search.value));
        }, 200);
      });
    }
  });
})();
