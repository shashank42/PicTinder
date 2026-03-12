/* ── Paddle Configuration ──────────────────────────────────────── */
const PADDLE_CLIENT_TOKEN = 'live_821d471428c80f700c25e7bd347';
const PADDLE_PRICE_ID    = 'pri_01kkeemt0e32cny6fw4shy8ymb';
const PADDLE_ENV         = 'production';

/* ── Initialize Paddle ───────────────────────────────────────────── */
function initPaddle() {
  if (typeof Paddle === 'undefined') return;
  if (PADDLE_ENV === 'sandbox') {
    Paddle.Environment.set('sandbox');
  }
  Paddle.Setup({
    token: PADDLE_CLIENT_TOKEN,
    eventCallback: function (event) {
      if (event.name === 'checkout.completed') {
        var txnId = event.data && (event.data.transaction_id || event.data.id);
        if (txnId) {
          window.location.href = '/success.html?txn=' + encodeURIComponent(txnId);
        }
      }
    },
  });
}

document.addEventListener('DOMContentLoaded', function () {
  initPaddle();

  // ── Mobile nav toggle ───────────────────────────────────────────
  const hamburger = document.querySelector('.nav__hamburger');
  const mobileNav = document.querySelector('.nav__mobile');

  if (hamburger && mobileNav) {
    hamburger.addEventListener('click', function () {
      mobileNav.classList.toggle('is-open');
      hamburger.setAttribute(
        'aria-expanded',
        mobileNav.classList.contains('is-open')
      );
    });

    mobileNav.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', function () {
        mobileNav.classList.remove('is-open');
        hamburger.setAttribute('aria-expanded', 'false');
      });
    });
  }

  // ── Rotating hero badge ────────────────────────────────────────
  var badgeEl = document.getElementById('hero-badge');
  if (badgeEl) {
    var stories = [
      '"I shot a 25k-photo wedding and need to deliver 1,000 picks to the client."',
      '"Our team of 4 needs to cull 8,000 event photos before Monday."',
      '"I have 15,000 RAW files on an external drive and no idea where to start."',
      '"We photograph 200 products a week and need a fast keep-or-skip workflow."',
      '"Family trip, 3 phones, 6,000 photos — help us pick the best ones together."',
      '"I second-shoot weddings and need to shortlist 5,000 images overnight."',
      '"Our studio archives 50k+ images per year — we need first-pass culling on mobile."',
      '"I have 12,000 school portraits and need to flag the ones with closed eyes."',
    ];
    var badgeIndex = 0;
    badgeEl.textContent = stories[0];

    setInterval(function () {
      badgeEl.classList.add('is-fading');
      setTimeout(function () {
        badgeIndex = (badgeIndex + 1) % stories.length;
        badgeEl.textContent = stories[badgeIndex];
        badgeEl.classList.remove('is-fading');
      }, 400);
    }, 5000);
  }

  // ── Smooth scroll for anchor links ──────────────────────────────
  document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
    anchor.addEventListener('click', function (e) {
      var target = document.querySelector(this.getAttribute('href'));
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });
});

/* ── Paddle Checkout ─────────────────────────────────────────────── */
function openCheckout() {
  if (typeof Paddle === 'undefined') {
    alert('Payment system is loading. Please try again in a moment.');
    return;
  }
  Paddle.Checkout.open({
    items: [{ priceId: PADDLE_PRICE_ID, quantity: 1 }],
  });
}
