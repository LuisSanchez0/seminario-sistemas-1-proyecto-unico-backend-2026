# Cosmetics catalog: frontend migration

## BEFORE

Product used `title`, `price`, `description`, `sizes[]`, `slug`, `gender`, `category`, `images`, and `state`.

```js
sizes: [{ size: 'M', stock: 10 }]
```

Clothing categories: `INDUSTRIAL`, `TIPO POLO`, `CAMISA`, `BLUSA`, `OVEROL`, `GORRA`, `PLAYERA`, `CREWNECK`.

Gender values: `HOMBRES`, `MUJERES`, `UNISEX`.

## NOW

Product uses `title`, `price`, `description`, `stock`, `slug`, `category`, `subcategory`, `brand`, `images`, and `state`.

- `stock` is a nonnegative JSON number. The schema defaults it to zero; POST requires an explicit value. PATCH may omit it.
- `category` is a fixed, case-sensitive canonical identifier.
- `subcategory` and `brand` are dynamic MongoDB documents. Write their ObjectId strings; read populated objects.
- `sizes` and `gender` are removed. Remove size selectors, size-based inventory calculations, and gender filters.
- `images: [{ key, url }]` is unchanged and is managed through the image endpoints.
- `state` is visible in the product JSON. Public queries only return active products. DELETE performs soft deletion; POST/PATCH cannot set `state`.
- Product and classification JSON include both the existing `_id` and string `id`; `__v` is omitted at the top level. Populated classification objects include `id`, `_id`, `name`, `slug`, `state`, and, for subcategories, `category`.

Compatibility review: the dual identifier is intentional for the current transition because the original product handlers returned `_id`. New frontend code should use `id`. Public product endpoints do not need to expose `state`, since they return only active products; the current cache reader uses it internally. The recommended future public contract is `id` without `_id` or `state`, with cache metadata handled separately. This review leaves the documented response unchanged to avoid a silent contract change.

| Canonical category | Display label |
| --- | --- |
| `ROSTRO` | Rostro |
| `OJOS_Y_CEJAS` | Ojos y cejas |
| `LABIOS` | Labios |
| `LIMPIEZA` | Limpieza |
| `TRATAMIENTOS` | Tratamientos |
| `HIDRATACION` | Hidratación |
| `PROTECCION_SOLAR` | Protección solar |
| `PERFUMES` | Perfumes |

## New endpoints

GET endpoints are public. POST, PATCH, and DELETE require `Authorization: Bearer <JWT>` for an `ADMIN_ROLE` user.

| Method | Endpoint | Result / behavior |
| --- | --- | --- |
| GET | `/api/brands` | `{ ok: true, brands: [...] }`, active only |
| GET | `/api/brands/:id` | `{ ok: true, brand: {...} }` |
| POST | `/api/brands` | Create with `{ name, slug }`; 201 |
| PATCH | `/api/brands/:id` | Update `name` and/or `slug` |
| DELETE | `/api/brands/:id` | Soft delete; 409 if active products reference it |
| GET | `/api/subcategories` | `{ ok: true, subcategories: [...] }`; optional `?category=ROSTRO` |
| GET | `/api/subcategories/category/:category` | Same list response, filtered by canonical parent category |
| GET | `/api/subcategories/:id` | `{ ok: true, subcategory: {...} }` |
| POST | `/api/subcategories` | Create with `{ name, category, slug }`; 201 |
| PATCH | `/api/subcategories/:id` | Update `name`, `category`, and/or `slug` |
| DELETE | `/api/subcategories/:id` | Soft delete; 409 if active products reference it |

Names are trimmed, Unicode-normalized, and repeated whitespace is collapsed. Active brand names are case-insensitively unique. Slugs are trimmed and lowercased, and active brand slugs are unique. Subcategory name/slug uniqueness is scoped to its parent category. MongoDB partial unique indexes enforce these rules, including concurrent writes. Soft-deleted names/slugs can be reused.

Changing a subcategory's parent is rejected with 409 while active products reference it. Renaming a brand/subcategory clears product caches so populated values update immediately on subsequent reads.

## Changed product endpoints

| Method | Endpoint | Contract |
| --- | --- | --- |
| GET | `/api/products` | Active products; optional `category`, `subcategory`, `brand`, `limit`, `offset` |
| GET | `/api/products/stock` | Same filters, plus `stock > 0` |
| GET | `/api/products/:id` | Active product with populated classification objects |
| GET | `/api/products/slug/:slug` | Same response, found by slug |
| POST | `/api/products` | Admin; new payload below; 201 |
| PATCH | `/api/products/:id` | Admin; partial update of the eight editable fields below |
| DELETE | `/api/products/:id` | Admin; soft delete; `{ ok: true, msg }` |
| POST | `/api/upload/products/:id` | Admin; multipart `archivo`; existing WebP conversion and S3 upload |
| DELETE | `/api/upload/products/:id` | Admin; JSON `{ "key": "..." }`; existing S3 deletion |

Editable product fields: `title`, `price`, `description`, `stock`, `slug`, `category`, `subcategory`, `brand`. Title minimum length is 4; description 10; slug 3. Price and stock must be nonnegative JSON numbers. The image endpoints handle image mutations; product POST/PATCH do not accept image changes.

Lists keep `{ ok, count, pages, products }`. Pagination defaults to `limit=5`, `offset=0`; limit must be 1–100, offset must be nonnegative. Filters accept one canonical category or one ObjectId each, not comma-separated values.

Product create/update/detail responses retain the existing flattened envelope: `{ ok: true, ...product }`, not `{ product: {...} }`. Detail queries return 404 for inactive/missing products. Redis and database responses have matching shapes.

References must exist and be active. The backend checks the complete resulting product during PATCH, even if only category or subcategory is supplied. When changing parent category, send its matching subcategory in the same PATCH.

A mismatch returns HTTP 400:

```json
{
  "ok": false,
  "msg": "La subcategoría seleccionada no pertenece a la categoría del producto"
}
```

Other invalid input returns 400, duplicate active classification names/slugs and in-use deletion return 409, and missing/inactive detail resources return 404. JWT and admin authorization use the existing middleware and its 401 responses.

## Frontend Payload Changes

### Old

```json
{
  "title": "Camisa",
  "price": 150,
  "description": "...",
  "sizes": [{ "size": "M", "stock": 10 }],
  "gender": "HOMBRES",
  "category": "CAMISA"
}
```

### New

```json
{
  "title": "Fit Me Matte + Poreless",
  "price": 85,
  "description": "Base líquida de acabado mate",
  "stock": 15,
  "category": "ROSTRO",
  "subcategory": "SUBCATEGORY_ID",
  "brand": "BRAND_ID",
  "slug": "fit-me-matte-poreless"
}
```

Replace the placeholder IDs with actual MongoDB ObjectId strings. After reading a populated product, use `product.subcategory.id` and `product.brand.id` when submitting edits; do not send the populated objects.

## Frontend Filter Changes

Remove `gender` and `sizes` filters, including URL/query state and persisted cart/form state.

1. Select parent `category` from the canonical enum, using display labels only in the UI.
2. Fetch `GET /api/subcategories/category/:category`.
3. Select `subcategory`. Reset this selection when the parent category changes.
4. Load brands using `GET /api/brands` and select `brand`.
5. Send the selected subcategory and brand IDs when creating/updating products.

Example:

```http
GET /api/products/stock?category=ROSTRO&subcategory=SUBCATEGORY_ID&brand=BRAND_ID
```

Use `product.stock` for availability and quantity selectors. There is no per-size inventory.

## Compatibility Risks

Dependencies found in this checkout:

| Original location | Old dependency | Resolution |
| --- | --- | --- |
| `models/pruduct.js` | Clothing enum, `sizes[].size`, `sizes[].stock`, `gender` | Removed after confirming no current imports; canonical model is `models/product.js` |
| `controllers/products.controller.js` | Gender filters/cache keys; per-size stock queries, filters, and response transformation | Replaced by category/subcategory/brand filters and top-level stock |
| `helpers/email-generator.js`, `sendSellConfirmationEmail` | `line.size` / Talla row | Removed size row |
| `helpers/email-generator.js`, `sendAdminSellConfirmationNotificationEmail` | `line.size` / Talla column | Removed size cell and header |

No runtime JavaScript field dependencies on `sizes`, `gender`, or `line.size` remain. The integration tests intentionally submit legacy fields to confirm they are not persisted or returned; this guide also contains before/after examples.

The checkout contains no `models/sell.js`, `models/sell-finished.js`, `models/address.js`, sales controller, or cart module. `models/index.js` previously imported those absent models and prevented modules from loading; those imports/exports were removed. There is no `products[].size` Sell schema here to migrate or verify. If the frontend or another repository still sends sale/cart sizes, its DTOs, inventory decrement/reservation, and totals must be migrated before enabling checkout.

The final review searched all project source, including hidden/ignored project files, and local Git history. No Address, Sell, or SellFinished model definitions were found under alternative filenames or another module. The missing exports therefore remain absent. No current code requires the removed `pruduct.js` alias.

Legacy sales upload handlers remain in `controllers/uploads.controller.js` and the unregistered `routes/upload.route.js`; legacy address/sales validators remain in `helpers/db-validators.js`. Those depend on missing models and remain unavailable. The server mounts only the product image router at `/api/upload/products`; it does not enable those incomplete sales/address modules. Sales emails also contain existing custom-logo fields outside this catalog refactor's scope.

The exact registered image endpoints are `POST /api/upload/products/:id` and `DELETE /api/upload/products/:id` (singular `upload`). There is no `/api/uploads/products/:id` registration.

### Existing database and deployment

This refactor does not modify existing production documents or infer a cosmetics classification from clothing categories.

`migrate-mongo`, `migrate-mongo-config.js`, all four `migrate:*` npm scripts, and the initial/users migrations already exist in committed HEAD before this refactor. No migration framework or migration command was added. Only the catalog index migration is new. These uniqueness indexes are required for duplicate protection; Mongoose can also create the schema indexes when automatic index creation is enabled. The migration provides explicit provisioning through the existing deployment mechanism.

1. Back up existing data before migration.
2. Run the project's `npm run migrate:up` in the intended environment to create active-only name/slug uniqueness indexes for brands/subcategories. The added migration is `20260922010000-catalog-indexes.js`; it creates indexes only and can drop those indexes on rollback without deleting documents.
3. Create the real brand/subcategory records. Map each retained product to an appropriate canonical category and valid references; no brands/subcategories are preseeded.
4. Set each retained product's top-level stock from verified inventory. Only sum legacy size stocks if that accurately represents the new sellable product. Archive clothing products that are not being reused.
5. Explicitly unset the old `sizes` and `gender` fields on migrated MongoDB documents. Removing schema fields alone does not rewrite stored documents. Required references mean old unmigrated products can fail PATCH/image-removal validation.
6. Clear existing `product:*` and `products:*` Redis entries during deployment before serving the new frontend. Old individual cache entries otherwise keep their old representation until expiry. Standard TTL remains 300 seconds.

Product creation/update/deletion and image changes invalidate the product ID, old/new slugs where applicable, and all product lists. Active product caches are regenerated with populated classifications; soft-deleted products are not recached.

### Verification

`npm test` runs the integration suite with isolated temporary MongoDB and Redis processes on localhost. It requires `mongod` and `redis-server` on PATH and permission to bind localhost ports. It does not load `.env`, touch configured production databases, send email, or upload to real S3. WebP conversion runs; the S3 upload/delete transport is mocked. The tests exercise routes, JWT/admin checks, Mongoose validation, MongoDB uniqueness indexes, Redis caching, and image handlers.
