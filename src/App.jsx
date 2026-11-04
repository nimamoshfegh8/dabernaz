import { useState } from "react";
import { useNavigate } from "react-router-dom";
import "./App.css";

const quickActions = [
  { icon: "🎮", title: "اتاق بازی", color: "red" },
  { icon: "🏆", title: "تورنومنت", color: "gold" },
  { icon: "🎁", title: "قرعه کشی", color: "pink" },
  { icon: "👥", title: "دعوت از دوستان", color: "purple" },
];

const popularGames = [
  { title: "Bingo", icon: "🎱", image: "🎴" },
  { title: "Poker", icon: "🂡", image: "♠️" },
  { title: "Slots", icon: "🎰", image: "777" },
];

const navigationItems = [
  { icon: "⌂", title: "خانه" },
  { icon: "🏆", title: "تورنومنت" },
  { icon: "🎁", title: "قرعه کشی" },
  { icon: "♧", title: "دعوت دوستان" },
  { icon: "▣", title: "کیف پول" },
  { icon: "♙", title: "حساب کاربری" },
  { icon: "⚙", title: "تنظیمات" },
];

export default function App() {
  const navigate = useNavigate();

  const [notice, setNotice] = useState("");
  const [heroSlide, setHeroSlide] = useState(0);
  const [giftSlide, setGiftSlide] = useState(0);

  function handleAction(title) {
    if (title === "اتاق بازی" || title === "شروع بازی") {
      setNotice("");
      navigate("/game-rooms");
      return;
    }

    setNotice(`بخش «${title}» به‌زودی فعال می‌شود.`);
  }

  function handleNavigation(title) {
    if (title === "خانه") {
      navigate("/");
      return;
    }

    handleAction(title);
  }

  return (
    <main className="home-page" dir="rtl">
      {/* هدر سایت */}
      <header className="home-header">
        <div className="home-user">
          <div className="home-avatar">
            🐺
            <span className="online-indicator" />
          </div>

          <div className="home-user-info">
            <strong>MrNima</strong>
            <small>ID: 482736</small>
          </div>
        </div>

        <button
          className="home-logo"
          onClick={() => navigate("/")}
          aria-label="صفحه اصلی"
        >
          <span className="logo-crown">♛</span>
          <span>Dabernaz</span>
        </button>

        <button
          className="home-wallet"
          onClick={() => handleAction("کیف پول")}
        >
          <span className="wallet-icon">▣</span>

          <span className="wallet-info">
            <small>موجودی کیف پول</small>
            <strong>
              ۱۲,۴۵۰ <em>تومان</em>
            </strong>
          </span>

          <span className="wallet-plus">+</span>
        </button>
      </header>

      {/* بنر اصلی */}
      <section className="home-hero">
        <div className="hero-copy">
          <p className="hero-welcome">
            👑 به دبرنا خوش آمدید
          </p>

          {heroSlide === 0 ? (
            <>
              <h1>
                بازی کن،
                <span> برنده شو!</span>
              </h1>

              <p className="hero-description">
                هیجان، رقابت، جایزه‌های واقعی
              </p>
            </>
          ) : heroSlide === 1 ? (
            <>
              <h1>
                آماده‌ای؟
                <span> شروع کن!</span>
              </h1>

              <p className="hero-description">
                وارد بازی شو و شانس خودت رو امتحان کن
              </p>
            </>
          ) : (
            <>
              <h1>
                جایزه‌های
                <span> جذاب!</span>
              </h1>

              <p className="hero-description">
                رقابت کن و برای برنده شدن تلاش کن
              </p>
            </>
          )}

          <button
            className="primary-button"
            onClick={() => navigate("/game-rooms")}
          >
            شروع بازی <span>❯</span>
          </button>
        </div>

        <div className="hero-art" aria-hidden="true">
          <div className="hero-glow" />
          <div className="hero-cards">
            <div className="hero-card card-one">
              <small>A</small>
              <span>♥</span>
            </div>

            <div className="hero-card card-two">
              <small>A</small>
              <span>♠</span>
            </div>

            <div className="hero-card card-three">
              <small>A</small>
              <span>♦</span>
            </div>

            <div className="hero-card card-four">
              <small>A</small>
              <span>♥</span>
            </div>
          </div>

          <div className="hero-crown">♛</div>
        </div>

        <div className="slider-dots">
          {[0, 1, 2].map((index) => (
            <button
              key={index}
              className={heroSlide === index ? "selected" : ""}
              onClick={() => setHeroSlide(index)}
              aria-label={`بنر ${index + 1}`}
            />
          ))}
        </div>
      </section>

      {/* دسترسی سریع */}
      <section className="quick-actions">
        {quickActions.map((action) => (
          <button
            key={action.title}
            className={`quick-action ${action.color}`}
            onClick={() => handleAction(action.title)}
          >
            <span className="quick-action-icon">
              {action.icon}
            </span>

            <span className="quick-action-title">
              {action.title}
            </span>

            <span className="quick-action-arrow">❯</span>
          </button>
        ))}
      </section>

      {/* بنر هدیه */}
      <section className="gift-banner">
        <button
          className="banner-arrow banner-arrow-right"
          onClick={() =>
            setGiftSlide((current) => (current + 1) % 3)
          }
          aria-label="بنر بعدی"
        >
          ❯
        </button>

        <div className="gift-art" aria-hidden="true">
          <div className="gift-glow" />
          <div className="gift-box">🎁</div>
          <span className="gift-coin">♛</span>
        </div>

        <div className="gift-copy">
          {giftSlide === 0 ? (
            <>
              <h2>🎁 پاداش خوش‌آمدگویی</h2>
              <p>با ثبت‌نام در دبرنا، هدیه‌ات رو بگیر!</p>
            </>
          ) : giftSlide === 1 ? (
            <>
              <h2>🎉 جایزه‌های جذاب</h2>
              <p>منتظر رویدادهای ویژه دبرنا باش!</p>
            </>
          ) : (
            <>
              <h2>👥 دوستانت رو دعوت کن</h2>
              <p>با دوستانت بیشتر لذت ببر!</p>
            </>
          )}

          <button
            className="primary-button gift-button"
            onClick={() => handleAction("دریافت هدیه")}
          >
            دریافت هدیه <span>❯</span>
          </button>
        </div>

        <button
          className="banner-arrow banner-arrow-left"
          onClick={() =>
            setGiftSlide((current) => (current + 2) % 3)
          }
          aria-label="بنر قبلی"
        >
          ❮
        </button>

        <div className="gift-dots">
          {[0, 1, 2].map((index) => (
            <button
              key={index}
              className={giftSlide === index ? "selected" : ""}
              onClick={() => setGiftSlide(index)}
              aria-label={`هدیه ${index + 1}`}
            />
          ))}
        </div>
      </section>

      {/* بازی‌های محبوب */}
      <section className="popular-section">
        <div className="section-heading">
          <h2>
            <span>🔥</span> بازی‌های محبوب
          </h2>

          <button
            className="see-all"
            onClick={() => handleAction("همه بازی‌ها")}
          >
            ❮ همه بازی‌ها
          </button>
        </div>

        <div className="popular-games">
          {popularGames.map((game) => (
            <button
              key={game.title}
              className={`popular-game game-${game.title.toLowerCase()}`}
              onClick={() => handleAction(game.title)}
            >
              <div className="popular-game-art">
                {game.title === "Bingo" ? (
                  <div className="bingo-art">
                    <span>BINGO</span>
                    <strong>7</strong>
                    <span className="bingo-ball">🎱</span>
                  </div>
                ) : game.title === "Poker" ? (
                  <div className="poker-art">
                    <span>♠</span>
                    <span>♥</span>
                    <span>♦</span>
                    <span>♣</span>
                  </div>
                ) : (
                  <div className="slots-art">
                    <span>7</span>
                    <span>7</span>
                    <span>7</span>
                  </div>
                )}
              </div>

              <div className="popular-game-footer">
                <strong>{game.title}</strong>
                <span>❯</span>
              </div>
            </button>
          ))}
        </div>
      </section>

      {/* بنر تورنومنت */}
      <section className="tournament-banner">
        <div className="tournament-art" aria-hidden="true">
          🏆
        </div>

        <div className="tournament-copy">
          <h2>👑 جدیدترین تورنومنت‌ها</h2>
          <p>🏅 هر هفته با جوایز میلیونی!</p>
        </div>

        <button
          className="primary-button tournament-button"
          onClick={() => handleAction("تورنومنت")}
        >
          مشاهده <span>❯</span>
        </button>
      </section>

      {/* منوی پایین */}
      <nav className="bottom-navigation">
        {navigationItems.map((item) => (
          <button
            key={item.title}
            className={item.title === "خانه" ? "active" : ""}
            onClick={() => handleNavigation(item.title)}
          >
            <span className="nav-icon">{item.icon}</span>
            <small>{item.title}</small>
          </button>
        ))}
      </nav>

      {/* پیام‌ها */}
      {notice && (
        <div
          className="notice-backdrop"
          onClick={() => setNotice("")}
        >
          <div
            className="notice-box"
            role="dialog"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
          >
            <span className="notice-icon">ⓘ</span>
            <p>{notice}</p>

            <button onClick={() => setNotice("")}>
              متوجه شدم
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
