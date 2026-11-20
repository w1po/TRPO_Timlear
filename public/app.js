'use strict';

/**
 * public/app.js — клиентская логика Timlear.
 * Всё общение с бизнес-логикой идёт только через REST API в server.js.
 * Клиент не знает, как устроены JSON-файлы и модули на сервере.
 */

/* =========================================================================
   Состояние приложения
   ========================================================================= */

const API_BASE = '/api';
const TOKEN_KEY = 'timlear_token';
const STATUSES = ['Оплачен', 'В работе', 'Выполнен', 'Отменён'];
const STATUS_CLASSES = {
  'Оплачен': 'status-paid',
  'В работе': 'status-progress',
  'Выполнен': 'status-done',
  'Отменён': 'status-cancelled'
};

const state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  user: null,
  services: null,
  view: 'home',
  step: 1,
  authIntent: 'default',
  booking: {
    propertyType: 'apartment',
    area: 45,
    address: '',
    date: '',
    time: '10:00',
    packageId: 'general'
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
  return `${moneyFormatter.format(Math.round(Number(value) || 0))} ₽`;
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

function getArea() {
  return Number(state.booking.area);
}

function calculatePreview() {
  const property = getProperty();
  const pkg = getPackage();
  const area = getArea();

  if (!property || !pkg || !Number.isFinite(area) || area < 10 || area > 1000) {
    return null;
  }

  return Math.round(pkg.pricePerSqm * area * property.coefficient);
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
  if (!getPackage() || !state.booking.date || !state.booking.time) return false;
  const slot = new Date(`${state.booking.date}T${state.booking.time}:00`);
  return !Number.isNaN(slot.getTime()) && slot.getTime() >= Date.now() - 30 * 60 * 1000;
}

function markInvalid(input) {
  if (!input) return;
  const field = input.closest('.field');
  if (field) field.classList.add('is-invalid');
  input.focus({ preventScroll: true });
  input.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => field && field.classList.remove('is-invalid'), 2600);
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
  if (!getPackage()) {
    if (showMessage) toast('Выберите пакет услуг', 'error');
    return false;
  }
  if (!state.booking.date) {
    if (showMessage) toast('Выберите дату уборки', 'error');
    markInvalid($('#cleaning-date'));
    return false;
  }
  if (!state.booking.time) {
    if (showMessage) toast('Выберите время уборки', 'error');
    markInvalid($('#cleaning-time'));
    return false;
  }

  const slot = new Date(`${state.booking.date}T${state.booking.time}:00`);
  if (Number.isNaN(slot.getTime()) || slot.getTime() < Date.now() - 30 * 60 * 1000) {
    if (showMessage) toast('Выберите будущую дату и время', 'error');
    markInvalid($('#cleaning-time'));
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

  const dateInput = $('#cleaning-date');
  const timeInput = $('#cleaning-time');
  const areaInput = $('#area');
  const addressInput = $('#address');

  if (dateInput) {
    dateInput.min = getToday();
    dateInput.value = state.booking.date;
  }
  if (timeInput) timeInput.value = state.booking.time;
  if (areaInput) areaInput.value = state.booking.area;
  if (addressInput) addressInput.value = state.booking.address;

  renderProperties();
  renderPackages();
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

  container.innerHTML = state.services.packages.map((pkg) => `
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
        <span>₽ / м²</span>
      </span>
      <ul class="package-features">
        ${(pkg.features || []).map((feature) => `<li>${escapeHtml(feature)}</li>`).join('')}
      </ul>
      <span class="package-check"><i data-lucide="check"></i> Выбрано</span>
    </button>
  `).join('');
}

function renderSummary() {
  const empty = $('#summary-empty');
  const details = $('#summary-details');
  const payButton = $('#summary-pay');
  if (!empty || !details || !payButton) return;

  const property = getProperty();
  const pkg = getPackage();
  const area = getArea();
  const total = calculatePreview();
  const valid = Boolean(property && pkg && total !== null);

  empty.classList.toggle('hidden', valid);
  details.classList.toggle('hidden', !valid);
  payButton.classList.toggle('hidden', !valid);

  if (!valid) {
    details.innerHTML = '';
    return;
  }

  details.innerHTML = `
    <div class="summary-lines">
      <div class="summary-line">
        <span>Пакет</span>
        <strong>${escapeHtml(pkg.name)}</strong>
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
        <span>Тариф</span>
        <strong>${formatMoney(pkg.pricePerSqm)} / м²</strong>
      </div>
    </div>
    <div class="summary-total">
      <span>К оплате</span>
      <strong>${formatMoney(total)}</strong>
    </div>
  `;

  payButton.querySelector('span').textContent = 'Оплатить';
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

  const total = calculatePreview();
  const payLabel = $('#pay-button-label');
  if (payLabel) {
    payLabel.textContent = total !== null ? `Оплатить ${formatMoney(total)}` : 'Оплатить';
  }
}

function scrollToBooking() {
  const card = $('.booking-card');
  if (!card) return;
  const top = card.getBoundingClientRect().top + window.scrollY - 96;
  window.scrollTo({ top, behavior: 'smooth' });
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
        packageId: state.booking.packageId
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
    const total = calculatePreview();
    label.textContent = total !== null ? `Оплатить ${formatMoney(total)}` : 'Оплатить';
  }
}

function statusBadge(status) {
  const className = STATUS_CLASSES[status] || 'status-progress';
  return `<span class="status-badge ${className}">${escapeHtml(status)}</span>`;
}

function receiptHTML(order) {
  const isPaid = order.status === 'Оплачен';
  const status = statusBadge(order.status);
  const coefficient = Number(order.coefficient) || 1;

  return `
    <article class="receipt-paper">
      <div class="receipt-top">
        <div class="receipt-brand">
          <span class="brand-mark"><i data-lucide="shield-check"></i></span>
          <div>
            <strong>Мойдодыр</strong>
            <small>Timlear cleaning · виртуальная квитанция</small>
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
          <span>Услуга</span>
          <strong>${escapeHtml(order.packageName)}</strong>
          <small>Пакет клининга Timlear</small>
        </div>
        <div>
          <span>Помещение</span>
          <strong>${escapeHtml(order.propertyName)} · ×${formatNumber(coefficient)}</strong>
          <small>${formatNumber(order.area)} м²</small>
        </div>
        <div>
          <span>Стоимость</span>
          <strong>${formatMoney(order.total)}</strong>
          <small>${formatMoney(order.pricePerSqm)} / м²</small>
        </div>
      </div>

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
          <strong>${formatMoney(order.pricePerSqm)} × ${formatNumber(order.area)} м² × ${formatNumber(coefficient)}</strong>
        </div>
        <div class="receipt-line">
          <span>Способ оплаты</span>
          <strong>Демо-карта Мойдодыр PAY</strong>
        </div>
      </div>

      <div class="receipt-total">
        <span>Итого оплачено</span>
        <strong>${formatMoney(order.total)}</strong>
      </div>

      <div class="receipt-status-row">
        <div>
          ${status}
          <small style="display:block;margin-top:4px;color:var(--muted);font-size:8.5px;">
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

      <div class="receipt-footnote">Мойдодыр · Timlear · заказ ${escapeHtml(order.id)} · demo receipt</div>
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
      <small>В Timlear с</small>
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
                  <strong>${escapeHtml(order.packageName)}</strong>
                  <small>${escapeHtml(order.propertyName)} · ${formatNumber(order.area)} м²</small>
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
                  <strong>${escapeHtml(order.packageName)}</strong>
                  <small>${escapeHtml(order.propertyName)} · ${formatNumber(order.area)} м²</small>
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
          <span>₽ / м²</span>
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
    packageId: 'general'
  };
  state.step = 1;
  state.paidOrder = null;
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
      state.booking.packageId = packageCard.dataset.packageId;
      resetPaymentIfNeeded();
      renderPackages();
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

  $('#cleaning-date').addEventListener('change', (event) => {
    state.booking.date = event.target.value;
    resetPaymentIfNeeded();
    renderSummary();
  });

  $('#cleaning-time').addEventListener('change', (event) => {
    state.booking.time = event.target.value;
    resetPaymentIfNeeded();
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
  $('#footer-year').textContent = String(new Date().getFullYear());

  bindEvents();

  try {
    const { services } = await api('/services');
    state.services = services;

    if (!services.packages.some((pkg) => pkg.id === state.booking.packageId)) {
      state.booking.packageId = services.packages[0]?.id || '';
    }
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
