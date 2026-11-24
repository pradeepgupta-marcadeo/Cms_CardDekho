-- Extra settings of a 360 view: for the cabin panorama, the starting view { pan, tilt, fov } in degrees.
ALTER TABLE car_spins ADD COLUMN IF NOT EXISTS meta JSONB;
