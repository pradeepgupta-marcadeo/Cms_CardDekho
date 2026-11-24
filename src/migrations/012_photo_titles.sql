-- Photo title ("Front Left Quarter View", "Dashboard") for alt text and the gallery, and the exterior angle in degrees
-- (0 front, 90 left side, 180 rear, 270 right side) for the 360 view. NULL when the photo is not an exterior angle shot.
ALTER TABLE photos ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE photos ADD COLUMN IF NOT EXISTS angle INTEGER;
