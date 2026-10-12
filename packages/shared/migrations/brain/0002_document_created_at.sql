-- When a document was first written (updated_at moves with every change); used to measure index lag.
ALTER TABLE brain.documents ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
