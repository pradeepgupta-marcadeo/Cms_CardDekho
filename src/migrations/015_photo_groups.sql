-- The group a photo belongs to in the source's gallery viewer ("Looks", "Details", "Lights", "Dashboard", "Seats",
-- "Sunroof"...), so the website gallery can offer the same sub-tabs. NULL when the source gave none.
ALTER TABLE cardekho_photos ADD COLUMN IF NOT EXISTS grp TEXT;
ALTER TABLE photos ADD COLUMN IF NOT EXISTS grp TEXT;
