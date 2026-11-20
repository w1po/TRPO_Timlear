'use strict';

/**
 * ============================================================================
 *  modules/authModule.js — МОДУЛЬ АВТОРИЗАЦИИ И ПОЛЬЗОВАТЕЛЕЙ
 * ============================================================================
 *  Назначение модуля:
 *    • регистрация новых клиентов;
 *    • проверка учётных данных при входе;
 *    • хранение пользователей в data/users.json.
 *
 *  Инкапсуляция:
 *    Работа с файлом (чтение, запись, создание каталога, хеширование паролей)
 *    полностью скрыта внутри модуля. Наружу отдаются только два публичных
 *    метода — register() и login(). Никакой код за пределами модуля не знает,
 *    что данные лежат именно в JSON-файле и как устроен формат пароля.
 *
 *  Публичный интерфейс (module.exports):
 *    • register(userData)      — зарегистрировать пользователя;
 *    • login(login, password)  — проверить логин/пароль и вернуть пользователя.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ------------------------------------------------------------------------- */
/*  СКРЫТАЯ РЕАЛИЗАЦИЯ: пути, константы, работа с JSON                        */
/* ------------------------------------------------------------------------- */

const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const MIN_PASSWORD_LENGTH = 6;

/**
 * Создаёт объект ошибки с HTTP-статусом.
 * Статус нужен только для удобной обработки в server.js.
 * @param {string} message
 * @param {number} [statusCode=400]
 * @returns {Error}
 */
function fail(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/** Создаёт каталог data/, если его ещё нет. */
function ensureStorage() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

/** Читает пользователей из файла. При отсутствии файла возвращает []. */
function readUsers() {
  ensureStorage();

  if (!fs.existsSync(USERS_FILE)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(USERS_FILE, 'utf8').trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    throw fail('Не удалось прочитать базу пользователей', 500);
  }
}

/** Атомарно записывает массив пользователей в JSON-файл. */
function writeUsers(users) {
  ensureStorage();
  const tempFile = `${USERS_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(users, null, 2), 'utf8');
  fs.renameSync(tempFile, USERS_FILE);
}

/** Хеширует пароль с индивидуальной солью (пароли в открытом виде не хранятся). */
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const passwordHash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, passwordHash };
}

/** Сравнивает введённый пароль с сохранённым хешем за постоянное время. */
function verifyPassword(password, user) {
  const candidate = crypto.scryptSync(password, user.salt, 64);
  const stored = Buffer.from(user.passwordHash, 'hex');

  if (candidate.length !== stored.length) return false;
  return crypto.timingSafeEqual(candidate, stored);
}

/** Убирает из объекта пользователя всё, что нельзя отдавать клиенту. */
function toPublicUser(user) {
  return {
    id: user.id,
    name: user.name,
    login: user.login,
    email: user.email,
    phone: user.phone || '',
    role: user.role,
    createdAt: user.createdAt
  };
}

/** Проверяет корректность e-mail простым, но надёжным шаблоном. */
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(email);
}

/** Приводит строку к безопасному виду: обрезает пробелы и ограничивает длину. */
function cleanText(value, maxLength = 120) {
  return String(value == null ? '' : value).trim().slice(0, maxLength);
}

/**
 * Проверяет и приводит белорусский номер к формату +375 (XX) XXX-XX-XX.
 * Пустое значение допустимо: телефон при регистрации не обязателен.
 */
function normalizeBelarusPhone(value) {
  const raw = cleanText(value, 30);
  if (!raw) return '';

  const digits = raw.replace(/\D/g, '');
  let local = '';

  if (digits.length === 12 && digits.startsWith('375')) {
    local = digits.slice(3);
  } else if (digits.length === 11 && digits.startsWith('80')) {
    local = digits.slice(2);
  } else if (digits.length === 9) {
    local = digits;
  }

  if (!/^\d{9}$/.test(local)) {
    throw fail('Укажите белорусский номер в формате +375 (XX) XXX-XX-XX');
  }

  return `+375 (${local.slice(0, 2)}) ${local.slice(2, 5)}-${local.slice(5, 7)}-${local.slice(7, 9)}`;
}

/**
 * Создаёт дефолтных пользователей при запуске:
 *   • администратор  admin / admin123
 *   • клиент         user@mail.ru / 123456
 * Если файл уже существует, недостающие учётные записи добавляются,
 * а существующие не дублируются и не перезаписываются.
 */
function seedDefaultUsers() {
  const users = readUsers();
  let changed = false;

  const hasAdmin = users.some((user) => user.role === 'admin' && user.login === 'admin');
  if (!hasAdmin) {
    const password = hashPassword('admin123');
    users.push({
      id: 'usr_admin',
      name: 'Администратор',
      login: 'admin',
      email: 'admin@timlear.by',
      phone: '+375 (29) 111-22-33',
      role: 'admin',
      ...password,
      createdAt: new Date().toISOString()
    });
    changed = true;
  }

  const hasClient = users.some((user) => user.email.toLowerCase() === 'user@mail.ru');
  if (!hasClient) {
    const password = hashPassword('123456');
    users.push({
      id: 'usr_client',
      name: 'Артём',
      login: 'user',
      email: 'user@mail.ru',
      phone: '+375 (29) 222-33-44',
      role: 'client',
      ...password,
      createdAt: new Date().toISOString()
    });
    changed = true;
  }

  if (changed) {
    writeUsers(users);
  }
}

// Инициализация хранилища выполняется при первом подключении модуля.
seedDefaultUsers();

/* ------------------------------------------------------------------------- */
/*  ПУБЛИЧНЫЙ ИНТЕРФЕЙС МОДУЛЯ                                               */
/* ------------------------------------------------------------------------- */

/**
 * Регистрирует нового клиента.
 * @param {object} userData — { name, email, password, phone? }
 * @returns {object} публичные данные созданного пользователя (без пароля)
 */
function register(userData = {}) {
  const name = cleanText(userData.name, 60);
  const email = cleanText(userData.email, 120).toLowerCase();
  const phone = normalizeBelarusPhone(userData.phone);
  const password = String(userData.password || '');

  if (name.length < 2) {
    throw fail('Имя должно содержать минимум 2 символа');
  }
  if (!isValidEmail(email)) {
    throw fail('Укажите корректный e-mail');
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw fail(`Пароль должен содержать минимум ${MIN_PASSWORD_LENGTH} символов`);
  }

  const users = readUsers();

  if (users.some((user) => user.email.toLowerCase() === email)) {
    throw fail('Пользователь с таким e-mail уже зарегистрирован', 409);
  }

  // Логин по умолчанию — часть e-mail до @. При совпадении добавляем суффикс.
  const baseLogin = email.split('@')[0].replace(/[^a-z0-9._-]/gi, '') || 'client';
  let login = baseLogin;
  let suffix = 1;
  while (users.some((user) => user.login.toLowerCase() === login.toLowerCase())) {
    login = `${baseLogin}${suffix}`;
    suffix += 1;
  }

  const credentials = hashPassword(password);
  const user = {
    id: `usr_${crypto.randomUUID().slice(0, 8)}`,
    name,
    login,
    email,
    phone,
    role: 'client', // роль нельзя назначить через регистрацию — это защита
    ...credentials,
    createdAt: new Date().toISOString()
  };

  users.push(user);
  writeUsers(users);

  return toPublicUser(user);
}

/**
 * Проверяет учётные данные. Логином может быть логин или e-mail.
 * @param {string} login
 * @param {string} password
 * @returns {object} публичные данные пользователя
 */
function login(login, password) {
  const identifier = cleanText(login, 120).toLowerCase();
  const secret = String(password || '');

  if (!identifier || !secret) {
    throw fail('Введите логин и пароль');
  }

  const users = readUsers();
  const user = users.find(
    (item) =>
      item.login.toLowerCase() === identifier || item.email.toLowerCase() === identifier
  );

  // Одинаковый текст ошибки не раскрывает, существует ли такой пользователь.
  if (!user || !verifyPassword(secret, user)) {
    throw fail('Неверный логин или пароль', 401);
  }

  return toPublicUser(user);
}

// Наружу экспортируются ТОЛЬКО два публичных метода.
module.exports = {
  register,
  login
};
