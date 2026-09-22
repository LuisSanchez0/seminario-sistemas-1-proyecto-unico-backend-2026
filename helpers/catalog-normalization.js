const normalizeCatalogName = value => typeof value === 'string'
  ? value.normalize('NFKC').trim().replace(/\s+/g, ' ')
  : value;

const CATALOG_COLLATION = { locale: 'es', strength: 2 };

module.exports = { normalizeCatalogName, CATALOG_COLLATION };
