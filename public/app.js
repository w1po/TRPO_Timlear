'use strict';

/**
 * public/app.js — клиентская логика Purity.
 * Всё общение с бизнес-логикой идёт только через REST API в server.js.
 * Клиент не знает, как устроены JSON-файлы и модули на сервере.
 */

/* =========================================================================
   Состояние приложения
   ========================================================================= */

const API_BASE = '/api';
const TOKEN_KEY = 'purity_token';
const STATUSES = ['Оплачен', 'В работе', 'Выполнен', 'Отменён'];
const STATUS_CLASSES = {
  'Оплачен': 'status-paid',
  'В работе': 'status-progress',
  'Выполнен': 'status-done',
  'Отменён': 'status-cancelled'
};

const TIME_SLOTS = ['09:00', '10:00', '11:30', '13:00', '14:30', '16:00', '17:30', '19:00'];
const MONTHS = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'
];
const MONTHS_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'
];
const WEEKDAYS_FULL = [
  'Воскресенье', 'Понедельник', 'Вторник', 'Среда',
  'Четверг', 'Пятница', 'Суббота'
];
const MINSK_CENTER = [53.9006, 27.5590];
const MINSK_VIEWBOX = '27.30,54.10,27.80,53.75';

const state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  user: null,
  services: null,
  view: 'home',
  step: 1,
  authIntent: 'default',
  calendar: {
    year: new Date().getFullYear(),
    month: new Date().getMonth()
  },
  booking: {
    propertyType: 'apartment',
    area: 45,
    address: '',
    date: '',
    time: '10:00',
    packageId: 'general',
    extraServiceIds: []
  },
  orders: [],
  adminOrders: [],
  paidOrder: null
};

/* =========================================================================
   DOM и форматирование
   ========================================================================= */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const moneyFormatter = new Intl.NumberFormat('ru-RU');

function formatMoney(value) {
  return `${moneyFormatter.format(Math.round(Number(value) || 0))} Br`;
}

function formatNumber(value) {
  return moneyFormatter.format(Number(value) || 0);
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatDateLong(dateString) {
  if (!dateString) return '—';
  const date = new Date(`${dateString}T00:00:00`);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

function formatSelectedDate(dateString) {
  if (!dateString) return 'Дата не выбрана';
  const date = new Date(`${dateString}T00:00:00`);
  if (Number.isNaN(date.getTime())) return dateString;
  const withYear = date.getFullYear() !== new Date().getFullYear()
    ? ` ${date.getFullYear()}`
    : '';
  return `${WEEKDAYS_FULL[date.getDay()]}, ${date.getDate()} ${MONTHS_GENITIVE[date.getMonth()]}${withYear}`;
}

function isPastSlot(dateString, slot) {
  if (!dateString) return true;
  const value = new Date(`${dateString}T${slot}:00`);
  return Number.isNaN(value.getTime()) || value.getTime() < Date.now() - 30 * 60 * 1000;
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }[char]));
}

function plural(count, forms) {
  const abs = Math.abs(count) % 100;
  const tail = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (tail > 1 && tail < 5) return forms[1];
  if (tail === 1) return forms[0];
  return forms[2];
}

function toLocalISO(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getTomorrow() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return toLocalISO(date);
}

function getToday() {
  return toLocalISO(new Date());
}

function refreshIcons() {
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }
}

/* =========================================================================
   API и сессия
   ========================================================================= */

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;

  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  let data = {};
  try {
    data = await response.json();
  } catch (error) {
    data = {};
  }

  if (!response.ok) {
    if (response.status === 401 && state.token) {
      clearSession(true);
    }
    throw new Error(data.error || `Ошибка запроса (${response.status})`);
  }

  return data;
}

function setSession(token, user) {
  state.token = token;
  state.user = user;
  localStorage.setItem(TOKEN_KEY, token);
  renderAuthState();
  refreshIcons();
}

function clearSession(silent = false) {
  state.token = '';
  state.user = null;
  state.orders = [];
  localStorage.removeItem(TOKEN_KEY);
  renderAuthState();
  if (!silent) {
    toast('Вы вышли из аккаунта', 'info');
  }
}

/* =========================================================================
   Уведомления и модальные окна
   ========================================================================= */

function toast(message, type = 'success') {
  const container = $('#toast-container');
  if (!container) return;

  const icons = { success: 'check-circle-2', error: 'alert-circle', info: 'info' };
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.innerHTML = `<i data-lucide="${icons[type] || icons.info}"></i><span>${escapeHtml(message)}</span>`;
  container.appendChild(element);
  refreshIcons();

  setTimeout(() => {
    element.classList.add('leaving');
    setTimeout(() => element.remove(), 240);
  }, 4200);
}

function openModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
  refreshIcons();
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
  if (!$('.modal.open')) {
    document.body.classList.remove('modal-open');
  }
}

/* =========================================================================
   Работа с тарифами и предварительным расчётом
   ========================================================================= */

function getProperty() {
  return state.services
    ? state.services.propertyTypes.find((item) => item.id === state.booking.propertyType)
    : null;
}

function getPackage() {
  return state.services
    ? state.services.packages.find((item) => item.id === state.booking.packageId)
    : null;
}

function getExtraServices() {
  return state.services && Array.isArray(state.services.extraServices)
    ? state.services.extraServices
    : [];
}

function getSelectedExtras() {
  const selectedIds = state.booking.extraServiceIds || [];
  return getExtraServices().filter((extra) => selectedIds.includes(extra.id));
}

function getArea() {
  return Number(state.booking.area);
}

function calculatePreview() {
  const property = getProperty();
  const area = getArea();

  if (!property || !Number.isFinite(area) || area < 10 || area > 1000) {
    return null;
  }

  const pkg = getPackage() || null;
  const extras = getSelectedExtras();
  const baseTotal = pkg
    ? Math.round(Number(pkg.pricePerSqm) * area * Number(property.coefficient))
    : 0;
  const extrasTotal = extras.reduce(
    (sum, extra) => sum + Math.round(Number(extra.price) || 0),
    0
  );

  return {
    property,
    pkg,
    extras,
    area,
    baseTotal,
    extrasTotal,
    total: baseTotal + extrasTotal
  };
}

function isStep1Valid() {
  const property = getProperty();
  const area = getArea();
  return Boolean(
    property &&
    Number.isFinite(area) &&
    area >= 10 &&
    area <= 1000 &&
    state.booking.address.trim().length >= 5
  );
}

function isStep2Valid() {
  if ((!getPackage() && !getSelectedExtras().length) || !state.booking.date || !state.booking.time) {
    return false;
  }
  const slot = new Date(`${state.booking.date}T${state.booking.time}:00`);
  return !Number.isNaN(slot.getTime()) && slot.getTime() >= Date.now() - 30 * 60 * 1000;
}

function markInvalid(input) {
  if (!input) return;
  const field = input.closest('.field');
  const target = field || input;
  target.classList.add('is-invalid');
  if (typeof input.focus === 'function') input.focus({ preventScroll: true });
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => target.classList.remove('is-invalid'), 2600);
}

function validateStep1(showMessage = true) {
  const property = getProperty();
  const area = getArea();

  if (!property) {
    if (showMessage) toast('Выберите тип помещения', 'error');
    return false;
  }
  if (!Number.isFinite(area) || area < 10 || area > 1000) {
    if (showMessage) toast('Укажите площадь от 10 до 1000 м²', 'error');
    markInvalid($('#area'));
    return false;
  }
  if (state.booking.address.trim().length < 5) {
    if (showMessage) toast('Укажите адрес уборки (минимум 5 символов)', 'error');
    markInvalid($('#address'));
    return false;
  }
  return true;
}

function validateStep2(showMessage = true) {
  if (!getPackage() && !getSelectedExtras().length) {
    if (showMessage) {
      toast('Выберите основной пакет или хотя бы одну дополнительную услугу', 'error');
    }
    return false;
  }
  if (!state.booking.date) {
    if (showMessage) toast('Выберите дату уборки', 'error');
    markInvalid($('#calendar-card'));
    return false;
  }
  if (!state.booking.time) {
    if (showMessage) toast('Выберите время уборки', 'error');
    markInvalid($('#time-card'));
    return false;
  }

  const slot = new Date(`${state.booking.date}T${state.booking.time}:00`);
  if (Number.isNaN(slot.getTime()) || slot.getTime() < Date.now() - 30 * 60 * 1000) {
    if (showMessage) toast('Выберите будущую дату и время', 'error');
    markInvalid($('#time-card'));
    return false;
  }

  return true;
}

/* =========================================================================
   Рендер: шапка и навигация
   ========================================================================= */

function renderAuthState() {
  const user = state.user;
  $('#login-btn').classList.toggle('hidden', Boolean(user));
  $('#logout-btn').classList.toggle('hidden', !user);
  $('#user-chip').classList.toggle('hidden', !user);

  $$('.admin-only').forEach((element) => {
    element.classList.toggle('hidden', !user || user.role !== 'admin');
  });

  if (user) {
    $('#user-avatar').textContent = (user.name || 'П').trim().charAt(0).toUpperCase();
    $('#user-name').textContent = user.name;
    $('#user-role').textContent = user.role === 'admin' ? 'Администратор' : 'Клиент';
  }

  if (state.view === 'admin' && (!user || user.role !== 'admin')) {
    navigate('home');
  }
}

function navigate(view) {
  if (view === 'admin' && (!state.user || state.user.role !== 'admin')) {
    toast('Панель доступна только администратору', 'error');
    view = 'home';
  }

  state.view = view;

  $$('.view').forEach((section) => {
    section.classList.toggle('hidden', section.id !== `view-${view}`);
  });

  $$('.nav-link[data-view]').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === view);
  });

  if (view === 'home') {
    renderHome();
  } else if (view === 'account') {
    renderAccount();
    if (state.user) loadMyOrders();
  } else if (view === 'admin') {
    renderAdmin();
    loadAdmin();
  }

  refreshIcons();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* =========================================================================
   Рендер: калькулятор
   ========================================================================= */

function renderHome() {
  if (!state.services) return;

  const areaInput = $('#area');
  const addressInput = $('#address');

  if (areaInput) areaInput.value = state.booking.area;
  if (addressInput) addressInput.value = state.booking.address;

  renderProperties();
  renderPackages();
  renderExtras();
  renderSchedule();
  renderSummary();
  updateStepUI();
}

function renderProperties() {
  const container = $('#property-options');
  if (!container || !state.services) return;

  container.innerHTML = state.services.propertyTypes.map((property) => `
    <button class="property-card ${property.id === state.booking.propertyType ? 'selected' : ''}"
            type="button" data-property-id="${escapeHtml(property.id)}">
      <span class="property-icon"><i data-lucide="${escapeHtml(property.icon || 'building-2')}"></i></span>
      <span class="property-coefficient">×${formatNumber(property.coefficient)}</span>
      <strong>${escapeHtml(property.name)}</strong>
      <small>${escapeHtml(property.hint || '')}</small>
    </button>
  `).join('');
}

function renderPackages() {
  const container = $('#package-options');
  if (!container || !state.services) return;

  const packageCards = state.services.packages.map((pkg) => `
    <button class="package-card ${pkg.highlight ? 'premium' : ''} ${pkg.id === state.booking.packageId ? 'selected' : ''}"
            type="button" data-package-id="${escapeHtml(pkg.id)}">
      <span class="package-top">
        <span class="package-icon"><i data-lucide="${escapeHtml(pkg.icon || 'sparkles')}"></i></span>
        ${pkg.highlight ? '<span class="package-flag">Золотой стандарт</span>' : ''}
      </span>
      <h3>${escapeHtml(pkg.name)}</h3>
      <p>${escapeHtml(pkg.description || '')}</p>
      <span class="package-price">
        <strong>${formatNumber(pkg.pricePerSqm)}</strong>
        <span>Br / м²</span>
      </span>
      <ul class="package-features">
        ${(pkg.features || []).map((feature) => `<li>${escapeHtml(feature)}</li>`).join('')}
      </ul>
      <span class="package-check"><i data-lucide="check"></i> Выбрано</span>
    </button>
  `);

  const noPackageCard = `
    <button class="package-card package-card-none ${getPackage() ? '' : 'selected'}"
            type="button" data-package-id="">
      <span class="package-top">
        <span class="package-icon"><i data-lucide="package-x"></i></span>
        <span class="package-flag package-flag-none">Гибкий выбор</span>
      </span>
      <h3>Без основного пакета (только доп. услуги)</h3>
      <p>Подходит, если нужно только помыть окна, диван или убрать балкон.</p>
      <span class="package-price">
        <strong>0</strong>
        <span>Br / пакет</span>
      </span>
      <ul class="package-features">
        <li>Только нужные дополнительные услуги</li>
        <li>Без оплаты основного пакета</li>
        <li>Идеально для точечной уборки</li>
      </ul>
      <span class="package-check"><i data-lucide="check"></i> Выбрано</span>
    </button>
  `;

  container.innerHTML = [...packageCards, noPackageCard].join('');
}

function renderExtras() {
  const container = $('#extra-options');
  if (!container || !state.services) return;

  const extras = getExtraServices();
  if (!extras.length) {
    container.innerHTML = '<p class="extras-empty">Дополнительные услуги временно недоступны.</p>';
    return;
  }

  container.innerHTML = extras.map((extra) => {
    const selected = state.booking.extraServiceIds.includes(extra.id);
    return `
      <button class="extra-card ${selected ? 'selected' : ''}" type="button"
              data-extra-id="${escapeHtml(extra.id)}" aria-pressed="${selected}">
        <span class="extra-check"><i data-lucide="check"></i></span>
        <span class="extra-icon"><i data-lucide="${escapeHtml(extra.icon || 'sparkles')}"></i></span>
        <span class="extra-copy">
          <strong>${escapeHtml(extra.name)}</strong>
          <small>${escapeHtml(extra.hint || 'Дополнительная услуга к заказу')}</small>
        </span>
        <span class="extra-price">${formatMoney(extra.price)}</span>
      </button>
    `;
  }).join('');
}

function renderSchedule() {
  renderCalendar();
  renderTimeSlots();
}

function syncCalendarView(dateString) {
  const date = dateString ? new Date(`${dateString}T00:00:00`) : new Date();
  if (!Number.isNaN(date.getTime())) {
    state.calendar = { year: date.getFullYear(), month: date.getMonth() };
  }
}

function renderCalendar() {
  const container = $('#calendar-days');
  if (!container) return;

  const { year, month } = state.calendar;
  const title = $('#calendar-month');
  if (title) title.textContent = `${MONTHS[month]} ${year}`;

  const prev = $('#calendar-prev');
  if (prev) {
    const now = new Date();
    prev.disabled = year === now.getFullYear() && month === now.getMonth();
  }

  const firstDay = new Date(year, month, 1);
  const offset = (firstDay.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayIso = getToday();
  const cells = [];

  for (let index = 0; index < 42; index += 1) {
    const day = index - offset + 1;
    if (day < 1 || day > daysInMonth) {
      cells.push('<span class="calendar-day is-empty" aria-hidden="true"></span>');
      continue;
    }

    const iso = toLocalISO(new Date(year, month, day));
    const selected = iso === state.booking.date;
    const disabled = iso < todayIso;
    cells.push(`
      <button class="calendar-day ${selected ? 'selected' : ''} ${iso === todayIso ? 'today' : ''}"
              type="button" data-calendar-date="${iso}"
              aria-label="${escapeHtml(formatSelectedDate(iso))}" aria-pressed="${selected}"
              ${disabled ? 'disabled' : ''}>${day}</button>
    `);
  }

  container.innerHTML = cells.join('');
}

function renderTimeSlots() {
  const container = $('#time-slots');
  if (!container) return;

  const label = $('#selected-date-label');
  if (label) {
    label.textContent = state.booking.date
      ? formatSelectedDate(state.booking.date)
      : 'Сначала выберите дату';
  }

  container.innerHTML = TIME_SLOTS.map((slot) => {
    const selected = slot === state.booking.time;
    const disabled = isPastSlot(state.booking.date, slot);
    return `
      <button class="time-slot ${selected ? 'selected' : ''}" type="button"
              data-time-slot="${slot}" aria-pressed="${selected}"
              ${disabled ? 'disabled' : ''}>${slot}</button>
    `;
  }).join('');
}

function shiftCalendarMonth(delta) {
  const next = new Date(state.calendar.year, state.calendar.month + delta, 1);
  const now = new Date();
  const min = new Date(now.getFullYear(), now.getMonth(), 1);
  if (next < min) return;

  state.calendar = { year: next.getFullYear(), month: next.getMonth() };
  renderCalendar();
}

function selectBookingDate(dateString) {
  state.booking.date = dateString;

  if (!state.booking.time || isPastSlot(dateString, state.booking.time)) {
    state.booking.time = TIME_SLOTS.find((slot) => !isPastSlot(dateString, slot)) || '';
  }

  resetPaymentIfNeeded();
  renderCalendar();
  renderTimeSlots();
  renderSummary();
  updateStepUI();
}

function selectTimeSlot(slot) {
  state.booking.time = slot;
  resetPaymentIfNeeded();
  renderTimeSlots();
  renderSummary();
  updateStepUI();
}

function renderSummary() {
  const empty = $('#summary-empty');
  const details = $('#summary-details');
  const payButton = $('#summary-pay');
  if (!empty || !details || !payButton) return;

  const preview = calculatePreview();
  const hasSelection = Boolean(preview && (preview.pkg || preview.extras.length));

  empty.classList.toggle('hidden', Boolean(preview));
  details.classList.toggle('hidden', !preview);
  payButton.classList.toggle('hidden', !preview || !hasSelection);

  if (!preview) {
    details.innerHTML = '';
    return;
  }

  const { property, pkg, extras, area, baseTotal, extrasTotal, total } = preview;
  const extrasList = extras.length
    ? `
      <div class="summary-extra-list">
        ${extras.map((extra) => `
          <div class="summary-extra-item">
            <span>${escapeHtml(extra.name)}</span>
            <strong>${formatMoney(extra.price)}</strong>
          </div>
        `).join('')}
      </div>
      <div class="summary-extra-total">
        <span>Доп. услуги</span>
        <strong>${formatMoney(extrasTotal)}</strong>
      </div>
    `
    : '<span class="summary-extra-empty">Не выбраны</span>';

  details.innerHTML = `
    <div class="summary-lines">
      <div class="summary-line">
        <span>Пакет</span>
        <strong>${pkg ? escapeHtml(pkg.name) : 'Без пакета'}</strong>
      </div>
      <div class="summary-line">
        <span>Помещение</span>
        <strong>${escapeHtml(property.name)} · ×${formatNumber(property.coefficient)}</strong>
      </div>
      <div class="summary-line">
        <span>Площадь</span>
        <strong>${formatNumber(area)} м²</strong>
      </div>
      <div class="summary-line">
        <span>Дата</span>
        <strong>${state.booking.date ? escapeHtml(formatSelectedDate(state.booking.date)) : 'Не выбрана'}</strong>
      </div>
      <div class="summary-line">
        <span>Время</span>
        <strong>${state.booking.time || 'Не выбрано'}</strong>
      </div>
      ${pkg ? `
        <div class="summary-line">
          <span>Тариф пакета</span>
          <strong>${formatMoney(pkg.pricePerSqm)} / м²</strong>
        </div>
      ` : ''}
      <div class="summary-line summary-line-subtotal">
        <span>Стоимость пакета</span>
        <strong>${formatMoney(baseTotal)}</strong>
      </div>
      <div class="summary-extra-block">
        <span class="summary-extra-title">Дополнительные услуги</span>
        ${extrasList}
      </div>
      ${!hasSelection ? `
        <p class="summary-alert">Выберите пакет или хотя бы одну дополнительную услугу, чтобы перейти к оплате.</p>
      ` : ''}
    </div>
    <div class="summary-total">
      <span>К оплате</span>
      <strong>${formatMoney(total)}</strong>
    </div>
  `;

  payButton.querySelector('span').textContent = hasSelection ? 'Оплатить' : 'Выберите услугу';
}

function updateStepUI() {
  $$('.step-panel').forEach((panel) => {
    panel.classList.toggle('hidden', Number(panel.dataset.stepPanel) !== state.step);
  });

  $$('.step').forEach((step) => {
    const number = Number(step.dataset.stepTarget);
    step.classList.toggle('active', number === state.step);
    step.classList.toggle('completed', number < state.step);
  });

  updatePaymentState();

  const preview = calculatePreview();
  const hasSelection = Boolean(preview && (preview.pkg || preview.extras.length));
  const payLabel = $('#pay-button-label');
  if (payLabel) {
    payLabel.textContent = hasSelection
      ? `Оплатить ${formatMoney(preview.total)}`
      : 'Оплатить';
  }
}

function scrollToBooking() {
  const card = $('.booking-card');
  if (!card) return;
  const top = card.getBoundingClientRect().top + window.scrollY - 96;
  window.scrollTo({ top, behavior: 'smooth' });
}

const mapState = {
  instance: null,
  marker: null,
  selection: null,
  requestId: 0,
  lastRequestAt: 0,
  reverseTimer: null
};

function createMapMarkerIcon() {
  return window.L.divIcon({
    className: 'purity-map-marker',
    html: `
      <svg width="34" height="44" viewBox="0 0 34 44" aria-hidden="true">
        <path d="M17 1C8.7 1 2 7.6 2 15.8c0 11.1 15 27.2 15 27.2s15-16.1 15-27.2C32 7.6 25.3 1 17 1z"
              fill="#2B62A5" stroke="#D4AF37" stroke-width="2"/>
        <circle cx="17" cy="16" r="5.5" fill="#FFFFFF"/>
      </svg>
    `,
    iconSize: [34, 44],
    iconAnchor: [17, 42]
  });
}

function initAddressMap() {
  if (mapState.instance) return true;
  if (!window.L) {
    toast('Не удалось загрузить карту. Проверьте подключение к интернету.', 'error');
    return false;
  }

  const container = $('#address-map');
  if (!container) return false;

  const map = window.L.map(container, {
    center: MINSK_CENTER,
    zoom: 13,
    zoomControl: true,
    scrollWheelZoom: true
  });

  window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'
  }).addTo(map);

  const marker = window.L.marker(MINSK_CENTER, {
    draggable: true,
    icon: createMapMarkerIcon()
  }).addTo(map);

  marker.on('dragend', () => {
    const point = marker.getLatLng();
    scheduleReverseGeocode(point.lat, point.lng);
  });

  map.on('click', (event) => {
    marker.setLatLng(event.latlng);
    scheduleReverseGeocode(event.latlng.lat, event.latlng.lng);
  });

  mapState.instance = map;
  mapState.marker = marker;
  return true;
}

function setMapSelection(lat, lng, address, options = {}) {
  const pending = Boolean(options.pending);
  const addressElement = $('#map-selected-address');
  const coordsElement = $('#map-selected-coords');
  const applyButton = $('#map-apply-btn');
  const card = $('.map-selected-card');

  mapState.selection = pending || !address ? null : { lat, lng, address };

  if (addressElement) {
    addressElement.textContent = pending
      ? 'Определяем адрес…'
      : (address || 'Нажмите на карту или найдите адрес');
  }
  if (coordsElement) {
    coordsElement.textContent = `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)} · OpenStreetMap`;
  }
  if (applyButton) applyButton.disabled = pending || !address;
  if (card) card.classList.toggle('is-loading', pending);
}

function formatNominatimAddress(address = {}, displayName = '') {
  const city = address.city || address.town || address.village || address.municipality || 'Минск';
  const road = address.road || address.pedestrian || address.footway || address.path || '';
  const house = address.house_number || '';

  if (road) {
    return `${city}, ${road}${house ? `, ${house}` : ''}`;
  }
  if (address.amenity) {
    return `${city}, ${address.amenity}`;
  }
  if (displayName) {
    const parts = displayName
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length) return parts.slice(0, 4).join(', ');
  }
  return city;
}

async function nominatimFetch(url) {
  const wait = Math.max(0, 1100 - (Date.now() - mapState.lastRequestAt));
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  mapState.lastRequestAt = Date.now();

  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`геокодер ответил ${response.status}`);
  }
  return response.json();
}

async function reverseGeocode(lat, lng) {
  const requestId = ++mapState.requestId;

  try {
    const params = new URLSearchParams({
      format: 'jsonv2',
      lat: String(lat),
      lon: String(lng),
      zoom: '18',
      addressdetails: '1',
      'accept-language': 'ru'
    });
    const data = await nominatimFetch(`https://nominatim.openstreetmap.org/reverse?${params}`);

    if (requestId !== mapState.requestId) return;
    const address = formatNominatimAddress(data.address, data.display_name);
    if (!address) throw new Error('адрес не определён');
    setMapSelection(lat, lng, address);
  } catch (error) {
    if (requestId !== mapState.requestId) return;
    const fallback = `Минск, ${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`;
    setMapSelection(lat, lng, fallback);
    toast('Не удалось определить улицу — выберите точку ещё раз или воспользуйтесь поиском', 'error');
  }
}

function scheduleReverseGeocode(lat, lng) {
  clearTimeout(mapState.reverseTimer);
  setMapSelection(lat, lng, '', { pending: true });
  mapState.reverseTimer = setTimeout(() => reverseGeocode(lat, lng), 450);
}

function focusMapPoint(lat, lng, reverse = true) {
  if (!mapState.instance || !mapState.marker) return;
  const zoom = Math.max(mapState.instance.getZoom(), 15);
  mapState.instance.setView([lat, lng], zoom);
  mapState.marker.setLatLng([lat, lng]);
  if (reverse) scheduleReverseGeocode(lat, lng);
}

async function searchAddress(query, options = {}) {
  const clean = String(query || '').trim();
  if (!clean) {
    if (!options.silent) toast('Введите адрес для поиска', 'error');
    return false;
  }
  if (!initAddressMap()) return false;

  clearTimeout(mapState.reverseTimer);
  const searchId = ++mapState.requestId;

  const button = $('#map-search-btn');
  const label = button ? button.querySelector('span') : null;
  const originalLabel = label ? label.textContent : 'Найти';
  if (button) button.disabled = true;
  if (label) label.textContent = 'Ищем…';

  try {
    const fullQuery = /минск/i.test(clean) ? clean : `${clean}, Минск`;
    const params = new URLSearchParams({
      format: 'jsonv2',
      q: fullQuery,
      addressdetails: '1',
      limit: '1',
      'accept-language': 'ru',
      countrycodes: 'by',
      viewbox: MINSK_VIEWBOX,
      bounded: '1'
    });
    const results = await nominatimFetch(`https://nominatim.openstreetmap.org/search?${params}`);

    if (searchId !== mapState.requestId) return false;
    if (!Array.isArray(results) || !results.length) {
      if (!options.silent) toast('Адрес не найден. Уточните улицу и номер дома.', 'error');
      return false;
    }

    const result = results[0];
    const lat = Number(result.lat);
    const lng = Number(result.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new Error('некорректные координаты');
    }

    mapState.instance.setView([lat, lng], 16);
    mapState.marker.setLatLng([lat, lng]);
    setMapSelection(lat, lng, formatNominatimAddress(result.address, result.display_name));
    return true;
  } catch (error) {
    if (!options.silent) toast(`Не удалось найти адрес: ${error.message}`, 'error');
    return false;
  } finally {
    if (button) button.disabled = false;
    if (label) label.textContent = originalLabel;
  }
}

function openAddressMap() {
  openModal('map-modal');
  refreshIcons();

  setTimeout(() => {
    if (!initAddressMap()) return;
    mapState.instance.invalidateSize();

    const currentAddress = ($('#address')?.value || state.booking.address || '').trim();
    const searchInput = $('#map-search-input');
    if (searchInput) searchInput.value = currentAddress;

    if (mapState.selection && currentAddress === mapState.selection.address) {
      mapState.instance.setView([mapState.selection.lat, mapState.selection.lng], 16);
      mapState.marker.setLatLng([mapState.selection.lat, mapState.selection.lng]);
      setMapSelection(mapState.selection.lat, mapState.selection.lng, mapState.selection.address);
      return;
    }

    if (currentAddress.length >= 3) {
      searchAddress(currentAddress, { silent: true }).then((found) => {
        if (!found) {
          focusMapPoint(MINSK_CENTER[0], MINSK_CENTER[1], false);
          setMapSelection(MINSK_CENTER[0], MINSK_CENTER[1], '');
        }
      });
      return;
    }

    if (mapState.selection) {
      mapState.instance.setView([mapState.selection.lat, mapState.selection.lng], 16);
      mapState.marker.setLatLng([mapState.selection.lat, mapState.selection.lng]);
      setMapSelection(mapState.selection.lat, mapState.selection.lng, mapState.selection.address);
      return;
    }

    focusMapPoint(MINSK_CENTER[0], MINSK_CENTER[1], false);
    setMapSelection(MINSK_CENTER[0], MINSK_CENTER[1], '');
  }, 150);
}

function applyMapAddress() {
  const selection = mapState.selection;
  if (!selection || !selection.address) return;

  state.booking.address = selection.address;
  const input = $('#address');
  if (input) input.value = selection.address;

  resetPaymentIfNeeded();
  closeModal('map-modal');
  refreshIcons();
  toast('Адрес выбран на карте', 'success');
}

function goToStep(target, options = {}) {
  if (target > 1 && !validateStep1()) return false;
  if (target > 2 && !validateStep2()) return false;

  state.step = target;
  updateStepUI();
  refreshIcons();

  if (options.scroll !== false) scrollToBooking();
  return true;
}

/* =========================================================================
   Оплата и квитанция
   ========================================================================= */

function initDemoCard() {
  const number = $('#card-number');
  const holder = $('#card-holder');
  const expiry = $('#card-expiry');
  const cvc = $('#card-cvc');

  if (number) number.value = '4276 1600 1234 5678';
  if (holder) holder.value = 'ARTEM DEMO';
  if (expiry) expiry.value = '12/29';
  if (cvc) cvc.value = '123';

  updateCardPreview();
}

function updateCardPreview() {
  const digits = ($('#card-number')?.value || '').replace(/\D/g, '').slice(0, 16);
  const grouped = digits.padEnd(16, '•').match(/.{1,4}/g)?.join(' ') || '•••• •••• •••• ••••';
  const holder = ($('#card-holder')?.value || '').trim().toUpperCase();
  const expiry = ($('#card-expiry')?.value || '').trim();

  const numberPreview = $('#card-preview-number');
  const holderPreview = $('#card-preview-holder');
  const expiryPreview = $('#card-preview-expiry');

  if (numberPreview) numberPreview.textContent = grouped;
  if (holderPreview) holderPreview.textContent = holder || 'ИМЯ ФАМИЛИЯ';
  if (expiryPreview) expiryPreview.textContent = expiry || 'MM/YY';
}

function validateCardForm() {
  const digits = ($('#card-number')?.value || '').replace(/\D/g, '');
  const holder = ($('#card-holder')?.value || '').trim();
  const expiry = ($('#card-expiry')?.value || '').trim();
  const cvc = ($('#card-cvc')?.value || '').trim();
  const expiryMatch = /^(\d{2})\/(\d{2})$/.exec(expiry);
  const month = expiryMatch ? Number(expiryMatch[1]) : 0;

  if (digits.length !== 16) {
    toast('Введите 16 цифр номера карты', 'error');
    markInvalid($('#card-number'));
    return false;
  }
  if (holder.length < 2) {
    toast('Укажите держателя карты', 'error');
    markInvalid($('#card-holder'));
    return false;
  }
  if (!expiryMatch || month < 1 || month > 12) {
    toast('Укажите срок действия в формате ММ/ГГ', 'error');
    markInvalid($('#card-expiry'));
    return false;
  }
  if (!/^\d{3,4}$/.test(cvc)) {
    toast('Укажите CVC-код (3 цифры)', 'error');
    markInvalid($('#card-cvc'));
    return false;
  }
  return true;
}

function updatePaymentState() {
  const block = $('#payment-block');
  const result = $('#payment-result');
  const preview = $('#receipt-preview');
  if (!block || !result || !preview) return;

  const paid = Boolean(state.paidOrder);
  block.classList.toggle('hidden', paid);
  result.classList.toggle('hidden', !paid);

  if (paid) {
    if (preview.dataset.orderId !== state.paidOrder.id) {
      preview.innerHTML = receiptHTML(state.paidOrder);
      preview.dataset.orderId = state.paidOrder.id;
    }
    refreshIcons();
  } else {
    preview.innerHTML = '';
    preview.dataset.orderId = '';
  }
}

function resetPaymentIfNeeded() {
  if (!state.paidOrder) return;
  state.paidOrder = null;
  updatePaymentState();
}

async function submitPayment(event) {
  event.preventDefault();

  if (!state.user) {
    openAuth('login', 'payment');
    toast('Для оформления заказа войдите в аккаунт', 'info');
    return;
  }

  if (!validateStep1() || !validateStep2() || !validateCardForm()) return;

  const button = $('#pay-button');
  const label = $('#pay-button-label');
  button.disabled = true;
  label.textContent = 'Обрабатываем оплату…';

  try {
    const { order } = await api('/orders', {
      method: 'POST',
      body: {
        propertyType: state.booking.propertyType,
        area: state.booking.area,
        address: state.booking.address.trim(),
        date: state.booking.date,
        time: state.booking.time,
        packageId: state.booking.packageId || null,
        extraServiceIds: state.booking.extraServiceIds
      }
    });

    state.paidOrder = order;
    state.orders = [order, ...state.orders.filter((item) => item.id !== order.id)];
    updatePaymentState();
    refreshIcons();
    toast(`Заказ оплачен. Квитанция ${order.receiptNumber} готова`, 'success');
    scrollToBooking();
  } catch (error) {
    if (!state.user) {
      openAuth('login', 'payment');
    }
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
    const preview = calculatePreview();
    const hasSelection = Boolean(preview && (preview.pkg || preview.extras.length));
    label.textContent = hasSelection
      ? `Оплатить ${formatMoney(preview.total)}`
      : 'Оплатить';
  }
}

function statusBadge(status) {
  const className = STATUS_CLASSES[status] || 'status-progress';
  return `<span class="status-badge ${className}">${escapeHtml(status)}</span>`;
}

function getOrderExtras(order) {
  return Array.isArray(order.extras) ? order.extras : [];
}

function orderExtrasText(order) {
  const extras = getOrderExtras(order);
  return extras.length
    ? extras.map((extra) => extra.name).join(', ')
    : 'Без доп. услуг';
}

function receiptHTML(order) {
  const isPaid = order.status === 'Оплачен';
  const status = statusBadge(order.status);
  const coefficient = Number(order.coefficient) || 1;
  const extras = getOrderExtras(order);
  const hasPackage = Boolean(order.packageId);
  const packageName = hasPackage ? order.packageName : 'Без пакета';
  const baseTotal = order.baseTotal != null
    ? Number(order.baseTotal) || 0
    : (hasPackage ? Number(order.total) || 0 : 0);
  const extrasTotal = order.extrasTotal != null
    ? Number(order.extrasTotal) || 0
    : extras.reduce((sum, extra) => sum + (Number(extra.price) || 0), 0);

  return `
    <article class="receipt-paper">
      <div class="receipt-top">
        <div class="receipt-brand">
          <span class="brand-mark"><i data-lucide="shield-check"></i></span>
          <div>
            <strong>Purity</strong>
            <small>royal cleaning service · виртуальная квитанция</small>
          </div>
        </div>
        <div class="receipt-number-box">
          <span>Номер квитанции</span>
          <strong>${escapeHtml(order.receiptNumber)}</strong>
        </div>
      </div>

      <div class="receipt-divider"></div>

      <div class="receipt-caption">Клиент</div>
      <div class="receipt-client">
        <div>
          <strong>${escapeHtml(order.userName)}</strong>
          <small>${escapeHtml(order.userEmail)}</small>
        </div>
        <div>
          <strong>${formatDateTime(order.createdAt)}</strong>
          <small>Дата формирования квитанции</small>
        </div>
      </div>

      <div class="receipt-service">
        <div>
          <span>Основной пакет</span>
          <strong>${escapeHtml(packageName)}</strong>
          <small>${hasPackage ? 'Пакет клининга Purity' : 'Заказ только из дополнительных услуг'}</small>
        </div>
        <div>
          <span>Помещение</span>
          <strong>${escapeHtml(order.propertyName)} · ×${formatNumber(coefficient)}</strong>
          <small>${formatNumber(order.area)} м²</small>
        </div>
        <div>
          <span>Стоимость пакета</span>
          <strong>${formatMoney(baseTotal)}</strong>
          <small>${hasPackage ? `${formatMoney(order.pricePerSqm)} / м²` : 'Пакет не выбран'}</small>
        </div>
      </div>

      ${extras.length ? `
        <div class="receipt-extras">
          <div class="receipt-caption">Дополнительные услуги</div>
          <div class="receipt-lines">
            ${extras.map((extra) => `
              <div class="receipt-line">
                <span>${escapeHtml(extra.name)}</span>
                <strong>${formatMoney(extra.price)}</strong>
              </div>
            `).join('')}
            <div class="receipt-line receipt-extras-total">
              <span>Итого за дополнительные услуги</span>
              <strong>${formatMoney(extrasTotal)}</strong>
            </div>
          </div>
        </div>
      ` : ''}

      <div class="receipt-lines">
        <div class="receipt-line">
          <span>Адрес уборки</span>
          <strong>${escapeHtml(order.address)}</strong>
        </div>
        <div class="receipt-line">
          <span>Дата и время</span>
          <strong>${escapeHtml(formatDateLong(order.date))}, ${escapeHtml(order.time)}</strong>
        </div>
        <div class="receipt-line">
          <span>Расчёт</span>
          <strong>${hasPackage
            ? `${formatMoney(order.pricePerSqm)} × ${formatNumber(order.area)} м² × ${formatNumber(coefficient)}`
            : 'Только дополнительные услуги'}</strong>
        </div>
        ${extras.length ? `
          <div class="receipt-line">
            <span>Пакет</span>
            <strong>${formatMoney(baseTotal)}</strong>
          </div>
          <div class="receipt-line">
            <span>Доп. услуги</span>
            <strong>${formatMoney(extrasTotal)}</strong>
          </div>
        ` : ''}
        <div class="receipt-line">
          <span>Способ оплаты</span>
          <strong>Демо-карта Purity PAY</strong>
        </div>
      </div>

      <div class="receipt-total">
        <span>Итого оплачено</span>
        <strong>${formatMoney(order.total)}</strong>
      </div>

      <div class="receipt-status-row">
        <div>
          ${status}
          <small class="receipt-status-note">
            ${isPaid ? `Оплачено ${formatDateTime(order.paidAt)}` : `Обновлено ${formatDateTime(order.updatedAt)}`}
          </small>
        </div>
        ${isPaid ? '<span class="receipt-stamp">Оплачено</span>' : '<small>Квитанция действительна</small>'}
      </div>

      <div class="receipt-footer">
        <p>
          Спасибо за доверие! Квитанция сформирована автоматически и доступна
          в личном кабинете. Подпись и печать не требуются.
        </p>
        <div class="barcode" aria-hidden="true"></div>
      </div>

      <div class="receipt-footnote">Purity · заказ ${escapeHtml(order.id)} · demo receipt</div>
    </article>
  `;
}

function openReceipt(order) {
  if (!order) return;
  $('#receipt-modal-body').innerHTML = receiptHTML(order);
  openModal('receipt-modal');
  refreshIcons();
}

/* =========================================================================
   Личный кабинет
   ========================================================================= */

function renderAccount() {
  const guest = $('#account-guest');
  const content = $('#account-content');
  if (!guest || !content) return;

  guest.classList.toggle('hidden', Boolean(state.user));
  content.classList.toggle('hidden', !state.user);

  if (!state.user) return;

  const initial = (state.user.name || 'П').trim().charAt(0).toUpperCase();
  const registered = formatDateTime(state.user.createdAt).split(',')[0];
  const phone = state.user.phone
    ? `<span class="profile-tag"><i data-lucide="phone"></i> ${escapeHtml(state.user.phone)}</span>`
    : '';

  $('#profile-card').innerHTML = `
    <div class="profile-avatar">${escapeHtml(initial)}</div>
    <div class="profile-info">
      <h2>${escapeHtml(state.user.name)}</h2>
      <p>${escapeHtml(state.user.email)}</p>
      <div class="profile-tags">
        <span class="profile-tag"><i data-lucide="${state.user.role === 'admin' ? 'shield' : 'user-round'}"></i>
          ${state.user.role === 'admin' ? 'Администратор' : 'Клиент'}
        </span>
        ${phone}
      </div>
    </div>
    <div class="profile-meta">
      <small>В Purity с</small>
      <strong>${escapeHtml(registered)}</strong>
    </div>
  `;

  renderAccountOrders();
  refreshIcons();
}

function renderAccountOrders() {
  const container = $('#my-orders');
  const counter = $('#my-orders-count');
  if (!container) return;

  const count = state.orders.length;
  if (counter) {
    counter.textContent = `${count} ${plural(count, ['заказ', 'заказа', 'заказов'])}`;
  }

  if (!count) {
    container.innerHTML = `
      <div class="table-empty">
        <i data-lucide="package-open"></i>
        <p>У вас пока нет заказов. Самое время навести чистоту!</p>
        <button class="btn btn-primary btn-sm" type="button" data-view="home">
          <i data-lucide="calculator"></i> Рассчитать уборку
        </button>
      </div>
    `;
    refreshIcons();
    return;
  }

  container.innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>Квитанция</th>
            <th>Услуга</th>
            <th>Дата уборки</th>
            <th>Сумма</th>
            <th>Статус</th>
            <th>Действия</th>
          </tr>
        </thead>
        <tbody>
          ${state.orders.map((order) => `
            <tr>
              <td data-label="Квитанция">
                <div class="cell-main">
                  <strong>${escapeHtml(order.receiptNumber)}</strong>
                  <small>${formatDateTime(order.createdAt)}</small>
                </div>
              </td>
              <td data-label="Услуга">
                <div class="cell-main">
                  <strong>${escapeHtml(order.packageName || 'Без пакета')}</strong>
                  <small>${escapeHtml(order.propertyName)} · ${formatNumber(order.area)} м²</small>
                  <small class="cell-extras">${escapeHtml(orderExtrasText(order))}</small>
                </div>
              </td>
              <td data-label="Дата уборки">
                <div class="cell-main">
                  <strong>${escapeHtml(formatDateLong(order.date))}</strong>
                  <small>${escapeHtml(order.time)}</small>
                </div>
              </td>
              <td class="cell-amount" data-label="Сумма">${formatMoney(order.total)}</td>
              <td data-label="Статус">${statusBadge(order.status)}</td>
              <td data-label="Действия">
                <div class="table-actions">
                  <button class="icon-btn" type="button" data-receipt-id="${escapeHtml(order.id)}" title="Открыть квитанцию">
                    <i data-lucide="receipt-text"></i>
                  </button>
                  ${order.status === 'Оплачен' ? `
                    <button class="btn btn-danger btn-sm" type="button" data-cancel-id="${escapeHtml(order.id)}">
                      Отменить
                    </button>
                  ` : ''}
                </div>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;

  refreshIcons();
}

async function loadMyOrders() {
  if (!state.user) return;
  try {
    const { orders } = await api('/orders/my');
    state.orders = orders;
    renderAccountOrders();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function cancelOrder(orderId) {
  const order = state.orders.find((item) => item.id === orderId);
  const label = order ? ` ${order.receiptNumber}` : '';
  if (!window.confirm(`Отменить заявку${label}? Это действие нельзя отменить.`)) return;

  try {
    const response = await api(`/orders/${orderId}/cancel`, { method: 'POST' });
    if (state.paidOrder && state.paidOrder.id === response.order.id) {
      state.paidOrder = response.order;
    }
    toast('Заявка отменена', 'success');
    await loadMyOrders();
    renderAccount();
  } catch (error) {
    toast(error.message, 'error');
  }
}

/* =========================================================================
   Панель администратора
   ========================================================================= */

function renderAdmin() {
  if (!state.user || state.user.role !== 'admin') return;

  const orders = state.adminOrders;
  const active = orders.filter((order) => ['Оплачен', 'В работе'].includes(order.status)).length;
  const done = orders.filter((order) => order.status === 'Выполнен').length;
  const revenue = orders
    .filter((order) => order.status !== 'Отменён')
    .reduce((sum, order) => sum + Number(order.total || 0), 0);

  $('#admin-stats').innerHTML = `
    <div class="stat-card">
      <div class="stat-top">
        <span>Всего заказов</span>
        <span class="stat-icon"><i data-lucide="clipboard-list"></i></span>
      </div>
      <strong>${orders.length}</strong>
      <small>за всё время работы</small>
    </div>
    <div class="stat-card">
      <div class="stat-top">
        <span>Выручка</span>
        <span class="stat-icon gold"><i data-lucide="wallet"></i></span>
      </div>
      <strong>${formatMoney(revenue)}</strong>
      <small>без отменённых заказов</small>
    </div>
    <div class="stat-card">
      <div class="stat-top">
        <span>Активные</span>
        <span class="stat-icon"><i data-lucide="loader-circle"></i></span>
      </div>
      <strong>${active}</strong>
      <small>оплачены или в работе</small>
    </div>
    <div class="stat-card">
      <div class="stat-top">
        <span>Выполнено</span>
        <span class="stat-icon green"><i data-lucide="circle-check"></i></span>
      </div>
      <strong>${done}</strong>
      <small>уборок завершено</small>
    </div>
  `;

  renderAdminOrders();
  renderTariffs();
  refreshIcons();
}

function renderAdminOrders() {
  const container = $('#admin-orders');
  const counter = $('#admin-orders-count');
  if (!container) return;

  if (counter) counter.textContent = String(state.adminOrders.length);

  if (!state.adminOrders.length) {
    container.innerHTML = `
      <div class="table-empty">
        <i data-lucide="inbox"></i>
        <p>Заказов пока нет. Они появятся здесь после первой оплаты.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>Квитанция</th>
            <th>Клиент</th>
            <th>Услуга</th>
            <th>Уборка</th>
            <th>Сумма</th>
            <th>Статус</th>
            <th>Изменить</th>
          </tr>
        </thead>
        <tbody>
          ${state.adminOrders.map((order) => `
            <tr>
              <td data-label="Квитанция">
                <div class="cell-main">
                  <strong>${escapeHtml(order.receiptNumber)}</strong>
                  <small>${formatDateTime(order.createdAt)}</small>
                </div>
              </td>
              <td data-label="Клиент">
                <div class="cell-main">
                  <strong>${escapeHtml(order.userName)}</strong>
                  <small>${escapeHtml(order.userEmail)}</small>
                </div>
              </td>
              <td data-label="Услуга">
                <div class="cell-main">
                  <strong>${escapeHtml(order.packageName || 'Без пакета')}</strong>
                  <small>${escapeHtml(order.propertyName)} · ${formatNumber(order.area)} м²</small>
                  <small class="cell-extras">${escapeHtml(orderExtrasText(order))}</small>
                </div>
              </td>
              <td data-label="Уборка">
                <div class="cell-main">
                  <strong>${escapeHtml(formatDateLong(order.date))}</strong>
                  <small>${escapeHtml(order.time)} · ${escapeHtml(order.address)}</small>
                </div>
              </td>
              <td class="cell-amount" data-label="Сумма">${formatMoney(order.total)}</td>
              <td data-label="Статус">${statusBadge(order.status)}</td>
              <td data-label="Изменить">
                <div class="table-actions">
                  <select class="status-select" data-status-id="${escapeHtml(order.id)}" aria-label="Статус заказа ${escapeHtml(order.receiptNumber)}">
                    ${STATUSES.map((status) => `
                      <option value="${escapeHtml(status)}" ${status === order.status ? 'selected' : ''}>${escapeHtml(status)}</option>
                    `).join('')}
                  </select>
                  <button class="icon-btn" type="button" data-receipt-id="${escapeHtml(order.id)}" title="Открыть квитанцию">
                    <i data-lucide="receipt-text"></i>
                  </button>
                </div>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;

  refreshIcons();
}

function renderTariffs() {
  const container = $('#tariff-editor');
  if (!container || !state.services) return;

  container.innerHTML = state.services.packages.map((pkg) => `
    <form class="tariff-row" data-tariff-form="${escapeHtml(pkg.id)}">
      <div class="tariff-head">
        <span class="tariff-icon"><i data-lucide="${escapeHtml(pkg.icon || 'sparkles')}"></i></span>
        <strong>${escapeHtml(pkg.name)}</strong>
        <small>за 1 м²</small>
      </div>
      <div class="tariff-form">
        <label class="tariff-input">
          <input type="number" min="1" max="100000" step="1" value="${Number(pkg.pricePerSqm)}"
                 aria-label="Цена за м² для пакета ${escapeHtml(pkg.name)}" required>
          <span>Br / м²</span>
        </label>
        <button class="btn btn-primary btn-sm" type="submit">
          <i data-lucide="save"></i> Сохранить
        </button>
      </div>
    </form>
  `).join('');

  refreshIcons();
}

async function loadAdmin(showToast = false) {
  if (!state.user || state.user.role !== 'admin') return;

  try {
    const { orders } = await api('/admin/orders');
    state.adminOrders = orders;
    renderAdmin();
    if (showToast) toast('Данные обновлены', 'info');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function saveTariff(form) {
  const packageId = form.dataset.tariffForm;
  const input = form.querySelector('input[type="number"]');
  const button = form.querySelector('button[type="submit"]');
  if (!packageId || !input) return;

  button.disabled = true;
  try {
    const { package: updated } = await api(`/admin/tariffs/${encodeURIComponent(packageId)}`, {
      method: 'PUT',
      body: { pricePerSqm: Number(input.value) }
    });

    state.services.packages = state.services.packages.map((pkg) =>
      pkg.id === updated.id ? { ...pkg, ...updated } : pkg
    );

    renderPackages();
    renderSummary();
    renderTariffs();
    toast(`Тариф «${updated.name}» обновлён: ${formatMoney(updated.pricePerSqm)} / м²`, 'success');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function changeOrderStatus(orderId, status, select) {
  select.disabled = true;
  try {
    const { order } = await api(`/admin/orders/${encodeURIComponent(orderId)}/status`, {
      method: 'PATCH',
      body: { status }
    });
    state.adminOrders = state.adminOrders.map((item) => (item.id === order.id ? order : item));
    renderAdmin();
    toast(`Статус ${order.receiptNumber}: ${order.status}`, 'success');
  } catch (error) {
    toast(error.message, 'error');
    select.disabled = false;
    renderAdminOrders();
  }
}

/* =========================================================================
   Авторизация
   ========================================================================= */

function setAuthTab(mode) {
  $$('.auth-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.authTab === mode);
  });
  $('#login-form').classList.toggle('hidden', mode !== 'login');
  $('#register-form').classList.toggle('hidden', mode !== 'register');
}

function openAuth(mode = 'login', intent = 'default') {
  state.authIntent = intent;
  setAuthTab(mode);
  openModal('auth-modal');
  setTimeout(() => {
    const input = mode === 'login' ? $('#login-login') : $('#register-name');
    if (input) input.focus();
  }, 120);
}

async function handleLogin(event) {
  event.preventDefault();
  const submit = event.target.querySelector('button[type="submit"]');
  const login = $('#login-login').value.trim();
  const password = $('#login-password').value;

  if (!login || !password) {
    toast('Введите логин и пароль', 'error');
    return;
  }

  submit.disabled = true;
  try {
    const { token, user } = await api('/auth/login', {
      method: 'POST',
      body: { login, password }
    });

    setSession(token, user);
    closeModal('auth-modal');
    event.target.reset();
    toast(`С возвращением, ${user.name}!`, 'success');

    const intent = state.authIntent;
    state.authIntent = 'default';

    if (intent === 'payment') {
      navigate('home');
      goToStep(3, { scroll: true });
      toast('Аккаунт подтверждён — можно оплачивать заказ', 'info');
    } else if (user.role === 'admin') {
      navigate('admin');
    } else {
      navigate('account');
    }
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    submit.disabled = false;
  }
}

async function handleRegister(event) {
  event.preventDefault();
  const submit = event.target.querySelector('button[type="submit"]');
  const payload = {
    name: $('#register-name').value.trim(),
    email: $('#register-email').value.trim(),
    phone: $('#register-phone').value.trim(),
    password: $('#register-password').value
  };

  if (!payload.name || !payload.email || !payload.password) {
    toast('Заполните имя, e-mail и пароль', 'error');
    return;
  }

  submit.disabled = true;
  try {
    const { token, user } = await api('/auth/register', {
      method: 'POST',
      body: payload
    });

    setSession(token, user);
    closeModal('auth-modal');
    event.target.reset();
    toast(`Аккаунт создан. Добро пожаловать, ${user.name}!`, 'success');

    const intent = state.authIntent;
    state.authIntent = 'default';

    if (intent === 'payment') {
      navigate('home');
      goToStep(3, { scroll: true });
      toast('Аккаунт готов — завершите оплату', 'info');
    } else {
      navigate('account');
    }
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    submit.disabled = false;
  }
}

async function logout() {
  try {
    await api('/auth/logout', { method: 'POST' });
  } catch (error) {
    // Сессия могла уже истечь — локально всё равно выходим.
  }

  const wasPrivate = state.view === 'account' || state.view === 'admin';
  clearSession(true);
  toast('Вы вышли из аккаунта', 'info');
  if (wasPrivate) navigate('home');
}

/* =========================================================================
   Сброс формы заказа
   ========================================================================= */

function resetBooking() {
  state.booking = {
    propertyType: 'apartment',
    area: 45,
    address: '',
    date: getTomorrow(),
    time: '10:00',
    packageId: 'general',
    extraServiceIds: []
  };
  state.step = 1;
  state.paidOrder = null;
  syncCalendarView(state.booking.date);
  updatePaymentState();
  initDemoCard();
  renderHome();
  refreshIcons();
}

/* =========================================================================
   Обработчики событий
   ========================================================================= */

function bindEvents() {
  // Навигация, выбор карточек, модальные окна — через делегирование.
  document.addEventListener('click', (event) => {
    const viewTrigger = event.target.closest('[data-view]');
    if (viewTrigger) {
      event.preventDefault();
      navigate(viewTrigger.dataset.view);
      return;
    }

    const propertyCard = event.target.closest('[data-property-id]');
    if (propertyCard) {
      state.booking.propertyType = propertyCard.dataset.propertyId;
      resetPaymentIfNeeded();
      renderProperties();
      renderSummary();
      refreshIcons();
      return;
    }

    const packageCard = event.target.closest('[data-package-id]');
    if (packageCard) {
      const nextPackageId = packageCard.dataset.packageId || '';
      state.booking.packageId = state.booking.packageId === nextPackageId ? '' : nextPackageId;
      resetPaymentIfNeeded();
      renderPackages();
      renderSummary();
      updateStepUI();
      refreshIcons();
      return;
    }

    const extraCard = event.target.closest('[data-extra-id]');
    if (extraCard) {
      const extraId = extraCard.dataset.extraId;
      const selected = state.booking.extraServiceIds || [];
      state.booking.extraServiceIds = selected.includes(extraId)
        ? selected.filter((id) => id !== extraId)
        : [...selected, extraId];
      resetPaymentIfNeeded();
      renderExtras();
      renderSummary();
      updateStepUI();
      refreshIcons();
      return;
    }

    const stepTrigger = event.target.closest('[data-step-target]');
    if (stepTrigger) {
      goToStep(Number(stepTrigger.dataset.stepTarget));
      return;
    }

    const closeTrigger = event.target.closest('[data-close-modal]');
    if (closeTrigger) {
      closeModal(closeTrigger.dataset.closeModal);
      return;
    }

    const authTab = event.target.closest('[data-auth-tab]');
    if (authTab) {
      setAuthTab(authTab.dataset.authTab);
      return;
    }

    const demoChip = event.target.closest('[data-demo]');
    if (demoChip) {
      const credentials = demoChip.dataset.demo === 'admin'
        ? { login: 'admin', password: 'admin123' }
        : { login: 'user@mail.ru', password: '123456' };
      $('#login-login').value = credentials.login;
      $('#login-password').value = credentials.password;
      setAuthTab('login');
      return;
    }

    const receiptTrigger = event.target.closest('[data-receipt-id]');
    if (receiptTrigger) {
      const id = receiptTrigger.dataset.receiptId;
      const order = state.paidOrder?.id === id
        ? state.paidOrder
        : [...state.orders, ...state.adminOrders].find((item) => item.id === id);
      openReceipt(order);
      return;
    }

    const cancelTrigger = event.target.closest('[data-cancel-id]');
    if (cancelTrigger) {
      cancelOrder(cancelTrigger.dataset.cancelId);
    }
  });

  // Шаги
  $('#next-1').addEventListener('click', () => goToStep(2));
  $('#back-2').addEventListener('click', () => goToStep(1));
  $('#next-2').addEventListener('click', () => goToStep(3));
  $('#back-3').addEventListener('click', () => goToStep(2));
  $('#summary-pay').addEventListener('click', () => {
    if (!validateStep1() || !validateStep2()) return;
    goToStep(3);
  });

  // Поля заказа
  $('#area').addEventListener('input', (event) => {
    state.booking.area = event.target.value;
    resetPaymentIfNeeded();
    renderSummary();
  });

  $('#address').addEventListener('input', (event) => {
    state.booking.address = event.target.value;
    resetPaymentIfNeeded();
  });

  $('#address-map-btn').addEventListener('click', openAddressMap);

  $('#map-search-btn').addEventListener('click', () => {
    searchAddress($('#map-search-input').value);
  });

  $('#map-search-input').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    searchAddress(event.target.value);
  });

  $('#map-apply-btn').addEventListener('click', applyMapAddress);

  $('#calendar-prev').addEventListener('click', () => shiftCalendarMonth(-1));
  $('#calendar-next').addEventListener('click', () => shiftCalendarMonth(1));

  $('#calendar-days').addEventListener('click', (event) => {
    const day = event.target.closest('[data-calendar-date]');
    if (!day || day.disabled) return;
    selectBookingDate(day.dataset.calendarDate);
  });

  $('#time-slots').addEventListener('click', (event) => {
    const slot = event.target.closest('[data-time-slot]');
    if (!slot || slot.disabled) return;
    selectTimeSlot(slot.dataset.timeSlot);
  });

  // Форма оплаты
  $('#payment-form').addEventListener('submit', submitPayment);

  $('#card-number').addEventListener('input', (event) => {
    const digits = event.target.value.replace(/\D/g, '').slice(0, 16);
    event.target.value = digits.replace(/(.{4})/g, '$1 ').trim();
    updateCardPreview();
  });

  $('#card-holder').addEventListener('input', (event) => {
    event.target.value = event.target.value.replace(/[^a-zA-Zа-яА-ЯёЁ\s-]/g, '').toUpperCase();
    updateCardPreview();
  });

  $('#card-expiry').addEventListener('input', (event) => {
    const digits = event.target.value.replace(/\D/g, '').slice(0, 4);
    event.target.value = digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
    updateCardPreview();
  });

  $('#card-cvc').addEventListener('input', (event) => {
    event.target.value = event.target.value.replace(/\D/g, '').slice(0, 3);
  });

  // Результат оплаты
  $('#go-account-btn').addEventListener('click', () => navigate('account'));
  $('#new-order-btn').addEventListener('click', () => {
    resetBooking();
    navigate('home');
    toast('Можно оформить новый заказ', 'info');
  });
  $('#print-last-receipt').addEventListener('click', () => {
    if (!state.paidOrder) return;
    openReceipt(state.paidOrder);
    setTimeout(() => window.print(), 250);
  });
  $('#print-receipt-btn').addEventListener('click', () => window.print());

  // Авторизация
  $('#login-btn').addEventListener('click', () => openAuth('login'));
  $('#logout-btn').addEventListener('click', logout);
  $('#user-chip').addEventListener('click', () => navigate('account'));
  $('#account-login-btn').addEventListener('click', () => openAuth('login', 'account'));
  $('#login-form').addEventListener('submit', handleLogin);
  $('#register-form').addEventListener('submit', handleRegister);

  // Админ-панель
  $('#refresh-admin').addEventListener('click', () => loadAdmin(true));
  $('#tariff-editor').addEventListener('submit', (event) => {
    const form = event.target.closest('[data-tariff-form]');
    if (!form) return;
    event.preventDefault();
    saveTariff(form);
  });

  document.addEventListener('change', (event) => {
    const select = event.target.closest('[data-status-id]');
    if (select) {
      changeOrderStatus(select.dataset.statusId, select.value, select);
    }
  });

  // Закрытие модальных окон по Esc
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      $$('.modal.open').forEach((modal) => closeModal(modal.id));
    }
  });
}

/* =========================================================================
   Инициализация
   ========================================================================= */

async function restoreSession() {
  if (!state.token) return;

  try {
    const { user } = await api('/auth/me');
    state.user = user;
  } catch (error) {
    clearSession(true);
  }
}

async function init() {
  state.booking.date = getTomorrow();
  syncCalendarView(state.booking.date);
  $('#footer-year').textContent = String(new Date().getFullYear());

  bindEvents();

  try {
    const { services } = await api('/services');
    state.services = services;

    if (!services.packages.some((pkg) => pkg.id === state.booking.packageId)) {
      state.booking.packageId = services.packages[0]?.id || '';
    }

    const extraIds = new Set((services.extraServices || []).map((extra) => extra.id));
    state.booking.extraServiceIds = state.booking.extraServiceIds.filter((id) => extraIds.has(id));
  } catch (error) {
    toast(`Не удалось загрузить тарифы: ${error.message}`, 'error');
  }

  await restoreSession();

  renderAuthState();
  renderHome();
  renderAccount();
  initDemoCard();
  refreshIcons();
}

document.addEventListener('DOMContentLoaded', init);
