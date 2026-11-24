-- Real state road-tax slabs (from the VariantWise road-tax dataset) per city.
ALTER TABLE cities ADD COLUMN IF NOT EXISTS tax_rules JSONB;
ALTER TABLE cities ADD COLUMN IF NOT EXISTS tax_source JSONB;
