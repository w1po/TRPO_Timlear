'use strict';

/**
 * ============================================================================
 *  modules/calculatorModule.js — МОДУЛЬ ТАРИФОВ И РАСЧЁТА СТОИМОСТИ
 * ============================================================================
 *  Назначение модуля:
 *    • хранить пакеты услуг и коэффициенты типов помещений;
 *    • рассчитывать стоимость уборки по формуле:
 *          цена за м² × площадь × коэффициент помещения;
 *    • позволять администратору обновлять тарифы.
 *
 *  Инкапсуляция:
 *    Чтение/запись data/services.json, создание файла с тарифами по умолчанию
 *    и валидация данных скрыты внутри модуля. Наружу виден только результат —
 *    готовые объекты тарифов и итоговая сумма.
 *
 *  Публичный интерфейс (module.exports):
 *    • getServices()                              — тарифы и коэффициенты;
 *    • calculateTotal(propertyType, area, packageId) — итоговая стоимость;
 *    • updateTariff(packageId, newPrice)          — изменить цену пакета.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------------- */
/*  СКРЫТАЯ РЕАЛИЗАЦИЯ: файл тарифов, данные по умолчанию, валидация         */
/* ------------------------------------------------------------------------- */

const DATA_DIR = path.join(__dirname, '..', 'data');
const SERVICES_FILE = path.join(DATA_DIR, 'services.json');

/** Тарифная сетка по умолчанию. Создаётся при первом запуске приложения. */
const DEFAULT_SERVICES = {
  currency: 'RUB',
  propertyTypes: [
    {
      id: 'apartment',
      name: 'Квартира',
      coefficient: 1,
      icon: 'building-2',
      hint: 'Стандартный коэффициент'
    },
    {
      id: 'house',
      name: 'Дом',
      coefficient: 1.5,
      icon: 'house',
      hint: 'Больше площади и сложности'
    },
    {
      id: 'office',
      name: 'Офис',
      coefficient: 1.3,
      icon: 'briefcase',
      hint: 'Коммерческое помещение'
    }
  ],
  packages: [
    {
      id: 'basic',
      name: 'Базовая',
      pricePerSqm: 120,
      icon: 'sparkles',
      description: 'Регулярная поддерживающая уборка для чистоты каждый день.',
      features: [
        'Влажная уборка полов',
        'Удаление пыли с поверхностей',
        'Вынос мусора',
        'Протирка зеркал и стекла'
      ],
      highlight: false
    },
    {
      id: 'general',
      name: 'Генеральная',
      pricePerSqm: 220,
      icon: 'wand-sparkles',
      description: 'Глубокая уборка всех зон, включая труднодоступные места.',
      features: [
        'Всё из пакета «Базовая»',
        'Мытьё окон и подоконников',
        'Уборка кухни и санузла',
        'Чистка мебели и плинтусов',
        'Дезинфекция контактных поверхностей'
      ],
      highlight: false
    },
    {
      id: 'renovation',
      name: 'После ремонта',
      pricePerSqm: 320,
      icon: 'hard-hat',
      description: 'Удаление строительной пыли, следов краски и клея после работ.',
      features: [
        'Всё из пакета «Генеральная»',
        'Удаление строительной пыли',
        'Очистка следов краски и клея',
        'Полировка полов и плитки',
        'Финальная проверка по чек-листу'
      ],
      highlight: true
    }
  ],
  updatedAt: new Date().toISOString()
};

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

/** Возвращает глубокую копию, чтобы вызывающий код не мог изменить хранилище. */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Читает тарифы. Если файла нет — создаёт его с тарифами по умолчанию. */
function readServices() {
  ensureStorage();

  if (!fs.existsSync(SERVICES_FILE)) {
    writeServices(DEFAULT_SERVICES);
  }

  let services;
  try {
    services = JSON.parse(fs.readFileSync(SERVICES_FILE, 'utf8'));
  } catch (error) {
    throw fail('Файл тарифов повреждён', 500);
  }

  if (!Array.isArray(services.propertyTypes) || !Array.isArray(services.packages)) {
    throw fail('Некорректная структура файла тарифов', 500);
  }

  return services;
}

/** Атомарно сохраняет тарифы в JSON-файл. */
function writeServices(services) {
  ensureStorage();
  const tempFile = `${SERVICES_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(services, null, 2), 'utf8');
  fs.renameSync(tempFile, SERVICES_FILE);
}

/** Ищет тип помещения по идентификатору. */
function findPropertyType(services, propertyType) {
  const type = services.propertyTypes.find((item) => item.id === propertyType);
  if (!type) {
    throw fail('Неизвестный тип помещения');
  }
  return type;
}

/** Ищет пакет услуг по идентификатору. */
function findPackage(services, packageId) {
  const pkg = services.packages.find((item) => item.id === packageId);
  if (!pkg) {
    throw fail('Неизвестный пакет услуг');
  }
  return pkg;
}

/** Проверяет и нормализует площадь помещения. */
function parseArea(area) {
  const parsed = Number(area);
  if (!Number.isFinite(parsed) || parsed < 10 || parsed > 1000) {
    throw fail('Площадь должна быть числом от 10 до 1000 м²');
  }
  return Math.round(parsed * 10) / 10;
}

/** Проверяет новую цену тарифа. */
function parsePrice(newPrice) {
  const parsed = Number(newPrice);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100000) {
    throw fail('Цена за м² должна быть числом от 1 до 100 000 ₽');
  }
  return Math.round(parsed);
}

// При первом подключении модуль сам готовит файл тарифов.
readServices();

/* ------------------------------------------------------------------------- */
/*  ПУБЛИЧНЫЙ ИНТЕРФЕЙС МОДУЛЯ                                               */
/* ------------------------------------------------------------------------- */

/**
 * Возвращает тарифы и коэффициенты для калькулятора.
 * @returns {{currency: string, propertyTypes: object[], packages: object[], updatedAt: string}}
 */
function getServices() {
  return clone(readServices());
}

/**
 * Считает стоимость заказа на сервере (клиентская сумма не считается доверенной).
 * Формула: цена за м² × площадь × коэффициент типа помещения.
 * @param {string} propertyType — apartment | house | office
 * @param {number} area — площадь в м²
 * @param {string} packageId — basic | general | renovation
 * @returns {number} итоговая стоимость в рублях
 */
function calculateTotal(propertyType, area, packageId) {
  const services = readServices();
  const type = findPropertyType(services, propertyType);
  const pkg = findPackage(services, packageId);
  const normalizedArea = parseArea(area);

  return Math.round(pkg.pricePerSqm * normalizedArea * type.coefficient);
}

/**
 * Обновляет цену пакета (доступно только администратору на уровне server.js).
 * @param {string} packageId
 * @param {number} newPrice — новая цена за 1 м²
 * @returns {object} обновлённый пакет
 */
function updateTariff(packageId, newPrice) {
  const services = readServices();
  const pkg = findPackage(services, packageId);
  pkg.pricePerSqm = parsePrice(newPrice);

  services.updatedAt = new Date().toISOString();
  writeServices(services);

  return clone(pkg);
}

// Наружу экспортируются ТОЛЬКО три публичных метода.
module.exports = {
  getServices,
  calculateTotal,
  updateTariff
};
