import { useState } from "react";
import { useNavigate } from "react-router-dom";
import "./GameRoom.css";

const rooms = [
  {
    id: 1,
    title: "اتاق برنزی",
    price: 5000,
    sold: 5,
    capacity: 20,
    prize: 80000,
    color: "bronze",
  },
  {
    id: 2,
    title: "اتاق نقره‌ای",
    price: 10000,
    sold: 5,
    capacity: 20,
    prize: 160000,
    color: "silver",
  },
  {
    id: 3,
    title: "اتاق طلایی",
    price: 20000,
    sold: 12,
    capacity: 20,
    prize: 320000,
    color: "gold",
  },
  {
    id: 4,
    title: "اتاق ویژه",
    price: 50000,
    sold: 18,
    capacity: 20,
    prize: 800000,
    color: "purple",
  },
];

const winners = [
  { name: "Reza_777", price: 5000, symbol: "♠" },
  { name: "PandaKing", price: 10000, symbol: "♣" },
  { name: "sara_game", price: 20000, symbol: "♦" },
  { name: "TahaBoss", price: 50000, symbol: "♥" },
];

const money = (number) =>
  new Intl.NumberFormat("fa-IR").format(number);

export default function GameRoom() {
  const navigate = useNavigate();
  const [showRules, setShowRules] = useState(false);
  const [message, setMessage] = useState("");

  function joinRoom(room) {
    setMessage(
      `اتاق ${room.title} انتخاب شد. خرید کارت و پرداخت واقعی هنوز فعال نیست.`
    );
  }

  return (
    <main className="gr-page" dir="rtl">
      <header className="gr-header">
        <button
          className="gr-profile"
          onClick={() => navigate("/")}
          aria-label="بازگشت به خانه"
        >
          <span className="gr-avatar">🐺</span>
          <span>
            <strong>MrNima</strong>
            <small>ID: 482736</small>
          </span>
        </button>

        <button className="gr-logo" onClick={() => navigate("/")}>
          <span>♛</span>
          Dabernaz
        </button>

        <div className="gr-wallet">
          <span className="gr-wallet-icon">▣</span>
          <div>
            <small>موجودی کیف پول</small>
            <strong>
              {money(12450)} <em>تومان</em>
            </strong>
          </div>
          <button
            className="gr-plus"
            onClick={() => setMessage("بخش کیف پول هنوز فعال نشده است.")}
          >
            +
          </button>
        </div>
      </header>

      <section className="gr-title">
        <div className="gr-title-icon">🎮</div>
        <div className="gr-title-text">
          <h1>اتاق بازی</h1>
          <p>کارت بخر، بازی کن، برنده شو!</p>
        </div>
        <div className="gr-online">
          <span>👥</span>
          <div>
            <small>بازیکنان آنلاین</small>
            <strong>۲۴۷ <i /></strong>
          </div>
        </div>
      </section>

      <section className="gr-hero">
        <div className="gr-hero-copy">
          <span className="gr-eyebrow">DEBARN AZ ARENA</span>
          <h2>
            هر کارت شانس
            <br />
            <span>یک برنده!</span>
          </h2>
          <p>
            با خرید کارت وارد بازی شو
            <br />
            و شانس خودت رو امتحان کن!
          </p>
          <button
            className="gr-red-button"
            onClick={() => setShowRules(!showRules)}
          >
            قوانین بازی <span>ⓘ</span>
          </button>
        </div>

        <div className="gr-hero-art" aria-hidden="true">
          <div className="gr-stage">
            <div className="gr-card gr-card-a">
              <small>BINGO</small>
              <span>♛</span>
              <b>۷</b>
            </div>
            <div className="gr-card gr-card-b">
              <small>BINGO</small>
              <span>♛</span>
              <b>۲۴</b>
            </div>
            <div className="gr-card gr-card-c">
              <small>BINGO</small>
              <span>♛</span>
              <b>۴۸</b>
            </div>
            <div className="gr-orb">♛</div>
          </div>
        </div>

        <div className="gr-features">
          <div>
            <span>▤</span>
            <p>۳۰ کارت در هر اتاق</p>
          </div>
          <div>
            <span>◷</span>
            <p>شروع بعد از آماده‌شدن بازیکنان</p>
          </div>
          <div>
            <span>🎲</span>
            <p>هر ۳ ثانیه یک شماره</p>
          </div>
          <div>
            <span>♛</span>
            <p>برنده خط و سپس کارت کامل</p>
          </div>
        </div>
      </section>

      {showRules && (
        <section className="gr-rules">
          <h3>📋 قوانین بازی</h3>
          <p>هر اتاق ظرفیت مشخصی دارد و هر بازیکن می‌تواند تا ۴ کارت بخرد.</p>
          <p>بازی پس از آماده‌شدن کارت‌ها و ورود بازیکنان شروع می‌شود.</p>
          <p>هر ۳ ثانیه یک شماره اعلام می‌شود؛ ابتدا برنده خط و سپس برنده کارت کامل مشخص می‌شود.</p>
        </section>
      )}

      <section className="gr-rooms">
        <div className="gr-section-heading">
          <div>
            <span className="gr-eyebrow">CHOOSE YOUR ROOM</span>
            <h2>🃏 خرید کارت</h2>
          </div>
          <p>هر کارت، شانس برنده‌شدن رو بیشتر می‌کنه!</p>
        </div>

        <div className="gr-room-grid">
          {rooms.map((room) => (
            <article className={`gr-room-card ${room.color}`} key={room.id}>
              <div className="gr-room-crown">♛</div>

              <div className="gr-playing-cards" aria-hidden="true">
                <div className="gr-mini-card left">
                  <small>A</small>
                  <strong>♠</strong>
                </div>
                <div className="gr-mini-card middle">
                  <small>B</small>
                  <strong>♥</strong>
                </div>
                <div className="gr-mini-card right">
                  <small>7</small>
                  <strong>♦</strong>
                </div>
                <div className="gr-mini-chip">♛</div>
              </div>

              <h3>{room.title}</h3>

              <div className="gr-room-price">
                {money(room.price)} تومان
              </div>

              <div className="gr-room-capacity">
                ظرفیت: <strong>{money(room.sold)}</strong> / {money(room.capacity)}
              </div>

              <div className="gr-progress">
                <span
                  style={{
                    width: `${(room.sold / room.capacity) * 100}%`,
                  }}
                />
              </div>

              <div className="gr-room-sold">
                {money(room.sold)} / {money(room.capacity)}
              </div>

              <div className="gr-prize">
                <span>🏆 جایزه کل</span>
                <strong>{money(room.prize)}</strong>
              </div>

              <button
                className="gr-join"
                onClick={() => joinRoom(room)}
              >
                انتخاب اتاق <span>←</span>
              </button>
            </article>
          ))}
        </div>
      </section>

      <section className="gr-winners">
        <div className="gr-section-heading">
          <div>
            <span className="gr-eyebrow">RECENT WINNERS</span>
            <h2>🏆 برندگان اتاق‌ها</h2>
          </div>
        </div>

        <div className="gr-winner-grid">
          {winners.map((winner, index) => (
            <article className="gr-winner-card" key={winner.name}>
              <div className="gr-winner-crown">♛</div>
              <div className="gr-winner-avatar">
                {["🕶️", "🐼", "🥷", "🦁"][index]}
              </div>
              <strong>{winner.name}</strong>
              <div className="gr-winner-playing-card">
                <span>{winner.symbol}</span>
                <b>{["A", "K", "Q", "J"][index]}</b>
              </div>
              <div className="gr-winner-prize">
                برندهٔ {money(winner.price)} تومان
              </div>
            </article>
          ))}
        </div>

        <p className="gr-demo-note">
          اطلاعات برندگان در این نسخه نمایشی است.
        </p>
      </section>

      {message && (
        <div className="gr-message-backdrop" onClick={() => setMessage("")}>
          <div
            className="gr-message"
            role="dialog"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
          >
            <span>ⓘ</span>
            <p>{message}</p>
            <button onClick={() => setMessage("")}>متوجه شدم</button>
          </div>
        </div>
      )}

      <nav className="gr-bottom-nav">
        <button className="active" onClick={() => navigate("/")}>
          <span>⌂</span>
          <small>خانه</small>
        </button>
        <button onClick={() => setMessage("تورنومنت‌ها به‌زودی فعال می‌شوند.")}>
          <span>♜</span>
          <small>تورنومنت</small>
        </button>
        <button onClick={() => setMessage("قرعه‌کشی به‌زودی فعال می‌شود.")}>
          <span>🎁</span>
          <small>قرعه‌کشی</small>
        </button>
        <button onClick={() => setMessage("دعوت دوستان به‌زودی فعال می‌شود.")}>
          <span>♧</span>
          <small>دعوت دوستان</small>
        </button>
        <button onClick={() => setMessage("کیف پول به‌زودی فعال می‌شود.")}>
          <span>▣</span>
          <small>کیف پول</small>
        </button>
        <button onClick={() => setMessage("حساب کاربری به‌زودی فعال می‌شود.")}>
          <span>♙</span>
          <small>حساب کاربری</small>
        </button>
        <button onClick={() => setMessage("تنظیمات به‌زودی فعال می‌شود.")}>
          <span>⚙</span>
          <small>تنظیمات</small>
        </button>
      </nav>
    </main>
  );
}
