'use strict';

/**
 * ============================================================================
 *  server.js — ГЛАВНЫЙ СВЯЗУЮЩИЙ МОДУЛЬ
 * ============================================================================
 *  Здесь нет работы с JSON-файлами: этим занимаются три независимых модуля.
 *  Задача server.js — настроить Express, связать публичные интерфейсы модулей
 *  и раздать клиентскую часть из public/.
 *
 *  Связи между модулями:
 *    authModule       → регистрация и вход пользователей;
 *    calculatorModule → тарифы и серверный расчёт суммы;
 *    orderModule      → создание квитанции и управление заказами.
 *
 *  Пример связи: при оплате server.js НЕ доверяет сумме из браузера,
 *  а заново вызывает calculatorModule.calculateTotal(...), после чего передаёт
 *  проверенный результат в orderModule.createOrder(...).
 * ============================================================================
 */

const path = require('path');
const crypto = require('crypto');
const express = require('express');

// Явные связи с программными модулями через require.
const authModule = require('./modules/authModule');
const calculatorModule = require('./modules/calculatorModule');
const orderModule = require('./modules/orderModule');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 часов

/* ------------------------------------------------------------------------- */
/*  СКРЫТАЯ РЕАЛИЗАЦИЯ: сессии, авторизация, обработка ошибок                */
/* ------------------------------------------------------------------------- */

/**
 * Простое серверное хранилище сессий: token → { user, expiresAt }.
 * Пароли и хеши никогда не покидают authModule.
 */
const sessions = new Map();

/** Создаёт объект ошибки с HTTP-статусом. */
function httpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/** Оборачивает обработчик, чтобы его ошибки попали в общий error handler. */
function handle(handler) {
  return (req, res, next) => {
    try {
      handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

/** Выдаёт клиенту новый токен сессии. */
function createSession(user) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, {
    user,
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  return token;
}

/** Находит активную сессию по заголовку Authorization: Bearer <token>. */
function readSession(req) {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const token = match[1].trim();
  const session = sessions.get(token);
  if (!session) return null;

  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }

  // Продлеваем сессию при активности.
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

/** Middleware: маршрут доступен только авторизованному пользователю. */
function requireAuth(req, res, next) {
  const session = readSession(req);
  if (!session) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }
  req.user = session.user;
  req.token = req.headers.authorization.split(' ')[1];
  next();
}

/** Middleware: маршрут доступен только администратору. */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Доступ только для администратора' });
  }
  next();
}

/** Проверяет, что выбранная дата и время уборки ещё впереди. */
function assertBookingSlot(date, time) {
  const slot = new Date(`${date}T${time}:00`);
  if (Number.isNaN(slot.getTime())) {
    throw httpError('Некорректная дата или время уборки');
  }
  if (slot.getTime() < Date.now() - 30 * 60 * 1000) {
    throw httpError('Нельзя выбрать прошедшую дату или время');
  }
}

/** Периодически удаляет просроченные сессии. */
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt < now) sessions.delete(token);
  }
}, 60 * 60 * 1000).unref();

/* ------------------------------------------------------------------------- */
/*  НАСТРОЙКА EXPRESS                                                        */
/* ------------------------------------------------------------------------- */

app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use(express.static(PUBLIC_DIR));

/* ------------------------------------------------------------------------- */
/*  API АВТОРИЗАЦИИ (authModule)                                             */
/* ------------------------------------------------------------------------- */

app.post(
  '/api/auth/register',
  handle((req, res) => {
    const { name, email, password, phone } = req.body || {};

    // Публичный метод модуля сам валидирует данные и хеширует пароль.
    authModule.register({ name, email, password, phone });

    // После регистрации сразу выдаём сессию.
    const user = authModule.login(email, password);
    const token = createSession(user);

    res.status(201).json({ token, user });
  })
);

app.post(
  '/api/auth/login',
  handle((req, res) => {
    const { login, password } = req.body || {};
    const user = authModule.login(login, password);
    const token = createSession(user);

    res.json({ token, user });
  })
);

app.get(
  '/api/auth/me',
  requireAuth,
  handle((req, res) => {
    res.json({ user: req.user });
  })
);

app.post(
  '/api/auth/logout',
  handle((req, res) => {
    const header = String(req.headers.authorization || '');
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (match) sessions.delete(match[1].trim());
    res.json({ ok: true });
  })
);

/* ------------------------------------------------------------------------- */
/*  API ТАРИФОВ И РАСЧЁТА (calculatorModule)                                 */
/* ------------------------------------------------------------------------- */

app.get(
  '/api/services',
  handle((req, res) => {
    // Наружу отдаются только публичные данные, без деталей хранения.
    res.json({ services: calculatorModule.getServices() });
  })
);

/* ------------------------------------------------------------------------- */
/*  API ЗАКАЗОВ (calculatorModule + orderModule)                             */
/* ------------------------------------------------------------------------- */

app.post(
  '/api/orders',
  requireAuth,
  handle((req, res) => {
    const { propertyType, area, address, date, time, packageId } = req.body || {};

    const services = calculatorModule.getServices();
    const property = services.propertyTypes.find((item) => item.id === propertyType);
    if (!property) throw httpError('Выберите тип помещения');

    const pkg = services.packages.find((item) => item.id === packageId);
    if (!pkg) throw httpError('Выберите пакет услуг');

    const cleanAddress = String(address || '').trim();
    if (cleanAddress.length < 5) {
      throw httpError('Укажите адрес уборки (минимум 5 символов)');
    }
    if (!date || !time) {
      throw httpError('Укажите дату и время уборки');
    }
    assertBookingSlot(date, time);

    // Ключевая связь модулей: сумма пересчитывается на сервере.
    // Значение total из браузера полностью игнорируется.
    const verifiedTotal = calculatorModule.calculateTotal(propertyType, area, packageId);

    const order = orderModule.createOrder({
      userId: req.user.id,
      userName: req.user.name,
      userEmail: req.user.email,
      propertyType: property.id,
      propertyName: property.name,
      coefficient: property.coefficient,
      packageId: pkg.id,
      packageName: pkg.name,
      pricePerSqm: pkg.pricePerSqm,
      area: Number(area),
      address: cleanAddress,
      date,
      time,
      total: verifiedTotal
    });

    res.status(201).json({ order });
  })
);

app.get(
  '/api/orders/my',
  requireAuth,
  handle((req, res) => {
    res.json({ orders: orderModule.getOrdersByUser(req.user.id) });
  })
);

app.post(
  '/api/orders/:id/cancel',
  requireAuth,
  handle((req, res) => {
    const myOrders = orderModule.getOrdersByUser(req.user.id);
    const order = myOrders.find((item) => item.id === req.params.id);

    if (!order) throw httpError('Заказ не найден', 404);
    if (order.status !== 'Оплачен') {
      throw httpError('Отменить можно только оплаченный заказ до начала работ', 409);
    }

    const updated = orderModule.changeOrderStatus(order.id, 'Отменён');
    res.json({ order: updated });
  })
);

/* ------------------------------------------------------------------------- */
/*  API АДМИНИСТРАТОРА                                                      */
/* ------------------------------------------------------------------------- */

app.get(
  '/api/admin/orders',
  requireAuth,
  requireAdmin,
  handle((req, res) => {
    res.json({ orders: orderModule.getAllOrders() });
  })
);

app.patch(
  '/api/admin/orders/:id/status',
  requireAuth,
  requireAdmin,
  handle((req, res) => {
    const { status } = req.body || {};
    if (!status) throw httpError('Не указан новый статус');

    const updated = orderModule.changeOrderStatus(req.params.id, status);
    res.json({ order: updated });
  })
);

app.put(
  '/api/admin/tariffs/:packageId',
  requireAuth,
  requireAdmin,
  handle((req, res) => {
    const newPrice = req.body ? req.body.pricePerSqm ?? req.body.newPrice : undefined;
    const updated = calculatorModule.updateTariff(req.params.packageId, newPrice);
    res.json({ package: updated });
  })
);

/* ------------------------------------------------------------------------- */
/*  РАЗДАЧА ФРОНТЕНДА И ОБРАБОТКА ОШИБОК                                     */
/* ------------------------------------------------------------------------- */

// Неизвестный API-маршрут всегда отвечает JSON (а не HTML-страницей).
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API-маршрут не найден' });
});

// SPA-fallback: любой остальной путь отдаёт index.html.
app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Единый обработчик ошибок: модули бросают Error, сервер превращает их в JSON.
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);

  const statusCode =
    Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599
      ? error.statusCode
      : 500;

  if (statusCode >= 500) {
    console.error('[server] Внутренняя ошибка:', error);
  }

  res.status(statusCode).json({
    error: statusCode >= 500 ? 'Внутренняя ошибка сервера' : error.message
  });
});

/* ------------------------------------------------------------------------- */
/*  ЗАПУСК                                                                   */
/* ------------------------------------------------------------------------- */

if (require.main === module) {
  app.listen(PORT, () => {
    console.log('');
    console.log('  ╔══════════════════════════════════════════════════════╗');
    console.log('  ║   TIMLEAR · CLEANING SERVICE                         ║');
    console.log('  ╚══════════════════════════════════════════════════════╝');
    console.log(`  Сервер запущен:  http://localhost:${PORT}`);
    console.log('');
    console.log('  Демо-доступы:');
    console.log('    Администратор: admin / admin123');
    console.log('    Клиент:        user@mail.ru / 123456');
    console.log('');
  });
}

// Экспорт app полезен для автоматических тестов и не мешает node server.js.
module.exports = app;
