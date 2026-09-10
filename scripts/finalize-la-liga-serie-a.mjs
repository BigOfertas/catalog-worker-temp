import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PROJECT_REF = String(process.env.SUPABASE_PROJECT_ID ?? "").trim();
const ACCESS_TOKEN = String(process.env.SUPABASE_ACCESS_TOKEN ?? "").trim();
const API_BASE = `https://api.supabase.com/v1/projects/${encodeURIComponent(PROJECT_REF)}`;
const MAX_STAGE_CHUNK_BYTES = 240_000;

if (!PROJECT_REF || !ACCESS_TOKEN) {
  throw new Error("SUPABASE_PROJECT_ID e SUPABASE_ACCESS_TOKEN são obrigatórios.");
}

const headers = {
  authorization: `Bearer ${ACCESS_TOKEN}`,
  accept: "application/json",
  "content-type": "application/json",
};

function clean(value) {
  return String(value ?? "").trim();
}

function normalize(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .toUpperCase();
}

function signature(row) {
  return [
    normalize(row.time ?? row.team),
    normalize(row.name),
    normalize(row.season),
    normalize(row.commercial_type ?? row.commercialType),
  ].join("|");
}

function pushMap(map, key, row) {
  const list = map.get(key) ?? [];
  list.push(row);
  map.set(key, list);
}

function unique(rows) {
  return rows?.length === 1 ? rows[0] : null;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function dollarQuote(value) {
  let tag = "catalog_payload";
  while (value.includes(`$${tag}$`)) tag += "_x";
  return `$${tag}$${value}$${tag}$`;
}

function slugify(value) {
  return String(value ?? "catalog")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function api(endpoint, init = {}) {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(180_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${endpoint} HTTP ${response.status}: ${text.slice(0, 2500)}`);
  }
  return text ? JSON.parse(text) : null;
}

async function readOnly(query) {
  return api("/database/query/read-only", {
    method: "POST",
    body: JSON.stringify({ query }),
  });
}

async function protectedState() {
  const rows = await readOnly(`
    select
      (select count(*)::int from public.orders) as orders,
      (select count(*)::int from public.order_items) as order_items,
      (select count(*)::int from public.profiles) as profiles,
      (select count(*)::int from public.affiliates) as affiliates;
  `);
  if (!Array.isArray(rows) || !rows[0]) throw new Error("Não foi possível ler o estado protegido.");
  return rows[0];
}

function splitProducts(products, maxBytes) {
  const chunks = [];
  let current = [];
  let currentBytes = 2;
  for (const product of products) {
    const encoded = JSON.stringify(product);
    const encodedBytes = Buffer.byteLength(encoded, "utf8") + 1;
    if (encodedBytes > maxBytes) {
      throw new Error(`Produto excede limite seguro de staging (${encodedBytes} bytes).`);
    }
    if (current.length > 0 && currentBytes + encodedBytes > maxBytes) {
      chunks.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(product);
    currentBytes += encodedBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

async function reconcilePlan(plan) {
  const rows = await readOnly(`
    select
      p.id::text as id,
      p.catalog_source_key,
      p.catalog_source_title,
      p.catalog_code,
      p.name,
      p.time,
      p.season,
      s.commercial_type
    from public.products p
    left join public.product_purchase_settings s on s.product_id = p.id
    where p.status::text = 'active';
  `);

  const bySourceKey = new Map();
  const byTitle = new Map();
  const bySignature = new Map();
  for (const row of rows ?? []) {
    const sourceKey = clean(row.catalog_source_key);
    if (sourceKey) bySourceKey.set(sourceKey, row);
    if (row.catalog_source_title) {
      pushMap(byTitle, `${normalize(row.time)}|${normalize(row.catalog_source_title)}`, row);
    }
    pushMap(bySignature, signature(row), row);
  }

  const kept = [];
  const adopted = [];
  const skipped = [];
  for (const product of plan.products) {
    const incomingSourceKey = clean(product.sourceKey);
    if (incomingSourceKey && bySourceKey.has(incomingSourceKey)) {
      const row = bySourceKey.get(incomingSourceKey);
      kept.push({ ...product, catalogCode: row.catalog_code ?? product.catalogCode });
      adopted.push({ mode: "same_source_key", name: product.name, team: product.team ?? null, catalogCode: row.catalog_code ?? null });
      continue;
    }

    const titleKey = product.sourceTitle
      ? `${normalize(product.team)}|${normalize(product.sourceTitle)}`
      : null;
    const titleRows = titleKey ? byTitle.get(titleKey) : null;
    const sigRows = bySignature.get(signature(product));
    const titleCandidate = unique(titleRows);
    const signatureCandidate = unique(sigRows);
    const candidate = titleCandidate ?? signatureCandidate;

    if (!candidate) {
      const titleAmbiguous = (titleRows?.length ?? 0) > 1;
      const signatureAmbiguous = (sigRows?.length ?? 0) > 1;
      if (titleAmbiguous || signatureAmbiguous) {
        skipped.push({ reason: "ambiguous_existing_match", name: product.name, team: product.team ?? null, sourceTitle: product.sourceTitle ?? null });
        continue;
      }
      kept.push(product);
      continue;
    }

    const existingSourceKey = clean(candidate.catalog_source_key);
    if (!existingSourceKey) {
      skipped.push({ reason: "legacy_existing_without_source_key", name: product.name, team: product.team ?? null, sourceTitle: product.sourceTitle ?? null, catalogCode: candidate.catalog_code ?? null });
      continue;
    }

    kept.push({ ...product, sourceKey: existingSourceKey, catalogCode: candidate.catalog_code ?? product.catalogCode });
    adopted.push({
      mode: titleCandidate ? "same_team_source_title" : "same_team_name_season_type",
      name: product.name,
      team: product.team ?? null,
      catalogCode: candidate.catalog_code ?? null,
    });
  }

  const reconciled = {
    ...plan,
    batchKey: `${plan.batchKey}:reconciled-public-worker`,
    products: kept,
    summary: {
      ...plan.summary,
      products: kept.length,
      variants: kept.reduce((sum, product) => sum + (product.variants?.length ?? 0), 0),
      images: kept.reduce(
        (sum, product) => sum + (product.variants ?? []).reduce((inner, variant) => inner + (variant.images?.length ?? 0), 0),
        0,
      ),
      adoptedExisting: adopted.length,
      skippedExisting: skipped.length,
    },
  };
  return {
    plan: reconciled,
    report: { before: plan.products.length, kept: kept.length, adoptedExisting: adopted.length, skippedExisting: skipped.length, adopted, skipped },
  };
}

async function applyPlan(plan) {
  if (!Array.isArray(plan.products) || plan.products.length === 0) throw new Error("Plano reconciliado vazio.");
  const payloadObject = {
    schemaVersion: plan.schemaVersion ?? 1,
    batchKey: plan.batchKey,
    sourceAlbumUrl: plan.sourceAlbumUrl,
    products: plan.products,
  };
  const payload = JSON.stringify(payloadObject);
  const digest = crypto.createHash("sha256").update(payload).digest("hex").slice(0, 12);
  const migrationName = `catalog_batch_${slugify(plan.batchKey)}_${digest}`;
  const stageKey = `catalog-stage-${digest}`;
  const history = await api("/database/migrations");
  const historyNames = new Set(Array.isArray(history) ? history.map((item) => item?.name).filter(Boolean) : []);

  async function applyMigration(name, query) {
    if (historyNames.has(name)) {
      console.log(`CATALOG_MIGRATION_ALREADY_APPLIED migration=${name}`);
      return;
    }
    await api("/database/migrations", {
      method: "POST",
      body: JSON.stringify({ name, query }),
    });
    historyNames.add(name);
    console.log(`CATALOG_MIGRATION_APPLIED migration=${name}`);
  }

  if (historyNames.has(migrationName)) {
    console.log(`CATALOG_BATCH_ALREADY_APPLIED migration=${migrationName}`);
    return;
  }

  const directQuery = `
    select public.catalog_apply_normalized_batch(
      ${dollarQuote(payload)}::jsonb,
      false,
      true,
      999
    );
  `;
  const directBodyBytes = Buffer.byteLength(JSON.stringify({ name: migrationName, query: directQuery }), "utf8");
  if (directBodyBytes <= MAX_STAGE_CHUNK_BYTES) {
    await applyMigration(migrationName, directQuery);
    console.log(`CATALOG_BATCH_APPLIED migration=${migrationName} mode=direct products=${plan.products.length}`);
    return;
  }

  const chunks = splitProducts(plan.products, MAX_STAGE_CHUNK_BYTES);
  const initMigration = `catalog_stage_init_${digest}`;
  const initQuery = `
    create table if not exists public.catalog_import_staging (
      stage_key text not null,
      chunk_index integer not null,
      products jsonb not null,
      created_at timestamptz not null default now(),
      primary key (stage_key, chunk_index)
    );
    revoke all on table public.catalog_import_staging from public, anon, authenticated;
    grant all on table public.catalog_import_staging to service_role;
    delete from public.catalog_import_staging where stage_key = ${sqlLiteral(stageKey)};
  `;
  await applyMigration(initMigration, initQuery);

  for (let index = 0; index < chunks.length; index += 1) {
    const chunkJson = JSON.stringify(chunks[index]);
    const chunkMigration = `catalog_stage_${digest}_${String(index + 1).padStart(3, "0")}`;
    const chunkQuery = `
      insert into public.catalog_import_staging(stage_key, chunk_index, products)
      values (${sqlLiteral(stageKey)}, ${index}, ${dollarQuote(chunkJson)}::jsonb)
      on conflict (stage_key, chunk_index) do update
        set products = excluded.products,
            created_at = now();
    `;
    await applyMigration(chunkMigration, chunkQuery);
  }

  const headerPayload = JSON.stringify({
    schemaVersion: payloadObject.schemaVersion,
    batchKey: payloadObject.batchKey,
    sourceAlbumUrl: payloadObject.sourceAlbumUrl,
  });
  const finalQuery = `
    do $catalog_atomic_apply$
    declare
      v_products jsonb;
      v_payload jsonb;
    begin
      select coalesce(
        jsonb_agg(item.value order by staged.chunk_index, item.ordinality),
        '[]'::jsonb
      )
      into v_products
      from public.catalog_import_staging staged
      cross join lateral jsonb_array_elements(staged.products)
        with ordinality as item(value, ordinality)
      where staged.stage_key = ${sqlLiteral(stageKey)};

      if jsonb_array_length(v_products) <> ${plan.products.length} then
        raise exception 'Staging incompleto: esperado %, encontrado %',
          ${plan.products.length}, jsonb_array_length(v_products);
      end if;

      v_payload := jsonb_set(
        ${dollarQuote(headerPayload)}::jsonb,
        '{products}',
        v_products,
        true
      );

      perform public.catalog_apply_normalized_batch(
        v_payload,
        false,
        true,
        999
      );

      delete from public.catalog_import_staging where stage_key = ${sqlLiteral(stageKey)};
    end
    $catalog_atomic_apply$;
  `;
  await applyMigration(migrationName, finalQuery);
  console.log(`CATALOG_BATCH_APPLIED migration=${migrationName} mode=staged-atomic chunks=${chunks.length} products=${plan.products.length}`);
}

async function verifyFinal(plans, before) {
  const products = plans.flatMap((plan) => plan.products);
  const sourceKeys = products.map((product) => clean(product.sourceKey));
  if (sourceKeys.some((key) => !key)) throw new Error("Produto sem sourceKey no plano final.");
  if (new Set(sourceKeys).size !== sourceKeys.length) throw new Error("sourceKey duplicada no plano final.");

  const plannedVariants = products.reduce((sum, product) => sum + (product.variants?.length ?? 0), 0);
  const plannedImages = products.reduce(
    (sum, product) => sum + (product.variants ?? []).reduce((inner, variant) => inner + (variant.images?.length ?? 0), 0),
    0,
  );
  const sourceArray = `ARRAY[${sourceKeys.map(sqlLiteral).join(",")}]::text[]`;
  const rows = await readOnly(`
    with selected_products as (
      select p.*
      from public.products p
      where p.catalog_source_key = any(${sourceArray})
    )
    select
      (select count(*)::int from selected_products) as products,
      (select count(*)::int from selected_products where status::text = 'active') as active_products,
      (select count(distinct catalog_source_key)::int from selected_products) as distinct_source_keys,
      (select count(*)::int from selected_products where catalog_code is null) as missing_catalog_codes,
      (select count(distinct catalog_code)::int from selected_products) as distinct_catalog_codes,
      (select count(*)::int from public.product_variants v join selected_products p on p.id = v.product_id) as variants,
      (select count(*)::int from public.product_variants v join selected_products p on p.id = v.product_id where v.status::text = 'active') as active_variants,
      (select count(*)::int from public.product_images i join selected_products p on p.id = i.product_id where i.status::text = 'ready' and i.image_source = 'google_photos') as ready_google_images,
      (select count(*)::int from selected_products where campeonato = 'La Liga') as la_liga_products,
      (select count(*)::int from selected_products where campeonato = 'Serie A') as serie_a_products,
      (select min(catalog_code) from selected_products) as first_catalog_code,
      (select max(catalog_code) from selected_products) as last_catalog_code;
  `);
  const database = rows?.[0];
  if (!database) throw new Error("Verificação final não retornou dados.");

  const after = await protectedState();
  for (const key of ["orders", "order_items", "profiles", "affiliates"]) {
    if (Number(before[key]) !== Number(after[key])) {
      throw new Error(`Estado protegido alterado em ${key}: ${before[key]} -> ${after[key]}`);
    }
  }

  const expected = {
    products: products.length,
    active_products: products.length,
    distinct_source_keys: products.length,
    missing_catalog_codes: 0,
    distinct_catalog_codes: products.length,
    variants: plannedVariants,
    active_variants: plannedVariants,
    ready_google_images: plannedImages,
    la_liga_products: plans.find((plan) => plan.competition === "La Liga")?.products.length ?? 0,
    serie_a_products: plans.find((plan) => plan.competition === "Serie A")?.products.length ?? 0,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (Number(database[key]) !== Number(value)) {
      throw new Error(`Verificação final falhou em ${key}: esperado ${value}, recebido ${database[key]}`);
    }
  }

  const sampleRows = await readOnly(`
    select p.slug, p.name, p.catalog_code, p.campeonato, c.slug as category_slug
    from public.products p
    left join public.categories c on c.id = p.primary_category_id
    where p.catalog_source_key = any(${sourceArray})
    order by p.catalog_code asc;
  `);
  if (sampleRows.length !== products.length) {
    throw new Error(`Amostras: esperado ${products.length}, recebido ${sampleRows.length}.`);
  }
  const indexes = [...new Set([0, Math.floor((sampleRows.length - 1) * 0.25), Math.floor((sampleRows.length - 1) * 0.5), Math.floor((sampleRows.length - 1) * 0.75), sampleRows.length - 1])];
  const result = {
    planned: { products: products.length, variants: plannedVariants, images: plannedImages },
    database,
    protectedBefore: before,
    protectedAfter: after,
    samples: indexes.map((index) => sampleRows[index]),
  };
  return result;
}

const sourcePath = path.resolve("published/merged-plan.json");
const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
if (source?.summary?.albums !== 36 || source?.summary?.products !== 243 || source?.summary?.variants !== 304 || source?.summary?.images !== 1518) {
  throw new Error(`Resumo inesperado do plano publicado: ${JSON.stringify(source?.summary)}`);
}

const defs = [
  { competition: "La Liga", key: "la-liga", products: 154, variants: 193, images: 963 },
  { competition: "Serie A", key: "serie-a", products: 89, variants: 111, images: 555 },
];

const before = await protectedState();
writeJson(".artifacts/finalize/protected-before.json", before);

const finalPlans = [];
for (const def of defs) {
  const products = source.products.filter((product) => product.competition === def.competition);
  const variants = products.reduce((sum, product) => sum + (product.variants?.length ?? 0), 0);
  const images = products.reduce(
    (sum, product) => sum + (product.variants ?? []).reduce((inner, variant) => inner + (variant.images?.length ?? 0), 0),
    0,
  );
  if (products.length !== def.products || variants !== def.variants || images !== def.images) {
    throw new Error(`${def.competition}: source mismatch products=${products.length}/${def.products} variants=${variants}/${def.variants} images=${images}/${def.images}`);
  }

  const rawPlan = {
    schemaVersion: source.schemaVersion ?? 1,
    batchKey: `final-${def.key}-20260910-public-worker`,
    competition: def.competition,
    products,
  };
  const { plan, report } = await reconcilePlan(rawPlan);
  plan.competition = def.competition;
  writeJson(`.artifacts/finalize/${def.key}-reconcile.json`, report);
  writeJson(`.artifacts/finalize/${def.key}.json`, plan);
  if (plan.products.length === 0) throw new Error(`${def.competition}: plano reconciliado ficou vazio.`);
  console.log(`${def.key.toUpperCase().replaceAll("-", "_")}_RECONCILED products=${plan.products.length} adopted=${report.adoptedExisting} skipped=${report.skippedExisting}`);
  finalPlans.push(plan);
}

for (const plan of finalPlans) {
  await applyPlan(plan);
}

const verification = await verifyFinal(finalPlans, before);
writeJson(".artifacts/finalize/verification.json", verification);
console.log("FINALIZE_LA_LIGA_SERIE_A_OK");
console.log(JSON.stringify(verification, null, 2));
