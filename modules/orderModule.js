'use strict';

/**
 * ============================================================================
 *  modules/orderModule.js — МОДУЛЬ УПРАВЛЕНИЯ ЗАКАЗАМИ И КВИТАНЦИЯМИ
 * ============================================================================
 *  Назначение модуля:
 *    • создавать заказы с уникальным номером квитанции;
 *    • выдавать заказы клиенту и администратору;
 *    • менять статус заказа;
 *    • хранить всё в data/orders.json.
 *
 *  Инкапсуляция:
 *    Структура JSON-файла, генерация идентификаторов, подсчёт номера квитанции
 *    и проверка допустимых статусов скрыты внутри. Наружу — только четыре
 *    публичных операции. Созданный заказ всегда получает статус «Оплачен».
 *
 *  Публичный интерфейс (module.exports):
 *    • createOrder(orderPayload)
 *    • getOrdersByUser(userId)
 *    • getAllOrders()
 *    • changeOrderStatus(orderId, newStatus)
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ------------------------------------------------------------------------- */
/*  СКРЫТАЯ РЕАЛИЗАЦИЯ: хранилище, статусы, генерация квитанции               */
/* ------------------------------------------------------------------------- */

const DATA_DIR = path.join(__dirname, '..', 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

/** Внутренний перечень допустимых статусов (не экспортируется). */
const ALLOWED_STATUSES = ['Оплачен', 'В работе', 'Выполнен', 'Отменён'];

/** Создаёт объект ошибки с HTTP-статусом для server.js. */
function fail(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/** Гарантирует существование каталога data/. */
function ensureStorage() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

/** Глубокая копия объекта — защита внутреннего массива от изменений снаружи. */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Читает заказы. При отсутствии файла возвращает пустой массив. */
function readOrders() {
  ensureStorage();

  if (!fs.existsSync(ORDERS_FILE)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(ORDERS_FILE, 'utf8').trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    throw fail('Не удалось прочитать базу заказов', 500);
  }
}

/** Атомарно записывает заказы в JSON-файл. */
function writeOrders(orders) {
  ensureStorage();
  const tempFile = `${ORDERS_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(orders, null, 2), 'utf8');
  fs.renameSync(tempFile, ORDERS_FILE);
}

/** Возвращает заказы, отсортированные от новых к старым. */
function sortByDateDesc(orders) {
  return orders
    .slice()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/** Двузначное представление числа. */
function pad(value) {
  return String(value).padStart(2, '0');
}

/** Локальная дата в формате YYYYMMDD — основа номера квитанции. */
function receiptDatePart(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

/**
 * Генерирует уникальный номер квитанции вида TL-20261120-0001.
 * Номер не повторяется даже при параллельном создании заказов.
 */
function generateReceiptNumber(orders) {
  const prefix = `TL-${receiptDatePart()}-`;
  const sequences = orders
    .filter((order) => String(order.receiptNumber).startsWith(prefix))
    .map((order) => Number(String(order.receiptNumber).slice(prefix.length)))
    .filter((value) => Number.isFinite(value));

  let next = sequences.length ? Math.max(...sequences) + 1 : 1;
  let receiptNumber = `${prefix}${String(next).padStart(4, '0')}`;

  while (orders.some((order) => order.receiptNumber === receiptNumber)) {
    next += 1;
    receiptNumber = `${prefix}${String(next).padStart(4, '0')}`;
  }

  return receiptNumber;
}

/** Проверяет обязательную непустую строку. */
function requireText(value, fieldName, maxLength = 200) {
  const text = String(value == null ? '' : value).trim();
  if (!text) {
    throw fail(`Не заполнено поле «${fieldName}»`);
  }
  return text.slice(0, maxLength);
}

/** Проверяет формат даты YYYY-MM-DD. */
function requireDate(value) {
  const date = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(`${date}T00:00:00`).getTime())) {
    throw fail('Некорректная дата уборки');
  }
  return date;
}

/** Проверяет формат времени HH:MM. */
function requireTime(value) {
  const time = String(value || '').trim();
  if (!/^\d{2}:\d{2}$/.test(time)) {
    throw fail('Некорректное время уборки');
  }
  return time;
}

/** Проверяет сумму заказа. */
function requireTotal(value) {
  const total = Number(value);
  if (!Number.isFinite(total) || total <= 0) {
    throw fail('Некорректная сумма заказа');
  }
  return Math.round(total);
}

/* ------------------------------------------------------------------------- */
/*  ПУБЛИЧНЫЙ ИНТЕРФЕЙС МОДУЛЯ                                               */
/* ------------------------------------------------------------------------- */

/**
 * Создаёт оплаченный заказ и виртуальную квитанцию.
 * Сумма передаётся только после серверного расчёта в calculatorModule.
 * @param {object} orderPayload
 * @returns {object} созданный заказ
 */
function createOrder(orderPayload = {}) {
  const orders = readOrders();
  const now = new Date().toISOString();

  const order = {
    id: `ord_${crypto.randomUUID().slice(0, 8)}`,
    receiptNumber: generateReceiptNumber(orders),

    // Данные клиента
    userId: requireText(orderPayload.userId, 'клиент', 80),
    userName: requireText(orderPayload.userName, 'имя клиента', 120),
    userEmail: requireText(orderPayload.userEmail, 'e-mail клиента', 120),

    // Параметры услуги
    propertyType: requireText(orderPayload.propertyType, 'тип помещения', 40),
    propertyName: requireText(orderPayload.propertyName, 'название помещения', 80),
    coefficient: Number(orderPayload.coefficient) || 1,
    packageId: requireText(orderPayload.packageId, 'пакет услуг', 40),
    packageName: requireText(orderPayload.packageName, 'название пакета', 80),
    pricePerSqm: Number(orderPayload.pricePerSqm) || 0,
    area: Number(orderPayload.area) || 0,
    address: requireText(orderPayload.address, 'адрес', 250),
    date: requireDate(orderPayload.date),
    time: requireTime(orderPayload.time),
    total: requireTotal(orderPayload.total),

    // Заказ создаётся уже оплаченным — это правило бизнес-логики модуля.
    status: 'Оплачен',
    createdAt: now,
    paidAt: now,
    updatedAt: now,
    statusHistory: [{ status: 'Оплачен', changedAt: now, comment: 'Оплата подтверждена' }]
  };

  orders.push(order);
  writeOrders(orders);

  return clone(order);
}

/**
 * Возвращает заказы конкретного пользователя (для личного кабинета).
 * @param {string} userId
 * @returns {object[]}
 */
function getOrdersByUser(userId) {
  const id = String(userId || '').trim();
  if (!id) {
    throw fail('Не указан пользователь');
  }

  return clone(sortByDateDesc(readOrders().filter((order) => order.userId === id)));
}

/**
 * Возвращает все заказы (только для панели администратора).
 * @returns {object[]}
 */
function getAllOrders() {
  return clone(sortByDateDesc(readOrders()));
}

/**
 * Меняет статус заказа и фиксирует изменение в истории.
 * @param {string} orderId
 * @param {string} newStatus — Оплачен | В работе | Выполнен | Отменён
 * @returns {object} обновлённый заказ
 */
function changeOrderStatus(orderId, newStatus) {
  const id = String(orderId || '').trim();
  const status = String(newStatus || '').trim();

  if (!ALLOWED_STATUSES.includes(status)) {
    throw fail('Недопустимый статус заказа');
  }

  const orders = readOrders();
  const order = orders.find((item) => item.id === id);

  if (!order) {
    throw fail('Заказ не найден', 404);
  }

  if (order.status === status) {
    return clone(order);
  }

  const now = new Date().toISOString();
  order.status = status;
  order.updatedAt = now;
  order.statusHistory = Array.isArray(order.statusHistory) ? order.statusHistory : [];
  order.statusHistory.push({ status, changedAt: now });

  writeOrders(orders);
  return clone(order);
}

// Наружу экспортируются ТОЛЬКО четыре публичных метода.
module.exports = {
  createOrder,
  getOrdersByUser,
  getAllOrders,
  changeOrderStatus
};
