-- Migração: visitas de PDV por SLOT (horário da rota).
--
-- Um promotor pode ter duas rotas no MESMO PDV no mesmo dia (07:00 e 13:00).
-- Antes, pdv_visits era única por (promotor, pdv, dia): o check-in das 07:00
-- valia para as duas e o checkout da 07:00 impedia o check-in da 13:00.
--
-- A migração:
--   1. adiciona pdv_visits.slot_time (TIME, NOT NULL DEFAULT '00:00');
--   2. preenche o slot a partir das rotas ligadas à visita
--      (merch_routes.scheduled_time / window_start);
--   3. remove a constraint única antiga (3 colunas);
--   4. cria a constraint única nova (4 colunas, com slot_time).
--
-- Idempotente: pode rodar várias vezes sem efeito colateral.

-- 1) Coluna
ALTER TABLE pdv_visits ADD COLUMN IF NOT EXISTS slot_time TIME;

-- 2) Backfill: o slot da visita é o horário das rotas que ela contém.
UPDATE pdv_visits v
SET slot_time = COALESCE(
  (
    SELECT MIN(COALESCE(r.window_start, r.scheduled_time))
    FROM pdv_visit_routes pvr
    JOIN merch_routes r ON r.id = pvr.route_id
    WHERE pvr.visit_id = v.id
      AND COALESCE(r.window_start, r.scheduled_time) IS NOT NULL
  ),
  '00:00'::time
)
WHERE v.slot_time IS NULL;

-- 2b) NOT NULL + default. Sem NOT NULL, NULL não conflita no índice único e
-- voltariam a existir visitas duplicadas.
UPDATE pdv_visits SET slot_time = '00:00'::time WHERE slot_time IS NULL;
ALTER TABLE pdv_visits ALTER COLUMN slot_time SET DEFAULT '00:00'::time;
ALTER TABLE pdv_visits ALTER COLUMN slot_time SET NOT NULL;

-- 3) Remove a constraint única antiga (3 colunas), qualquer que seja o nome.
DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'pdv_visits'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) ILIKE '%promoter_id%'
      AND pg_get_constraintdef(oid) ILIKE '%pdv_id%'
      AND pg_get_constraintdef(oid) ILIKE '%visit_date%'
      AND pg_get_constraintdef(oid) NOT ILIKE '%slot_time%'
  LOOP
    EXECUTE format('ALTER TABLE pdv_visits DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

-- 4) Chave única nova (4 colunas) + índices de apoio.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pdv_visits_promoter_pdv_date_slot
  ON pdv_visits (promoter_id, pdv_id, visit_date, slot_time);

CREATE INDEX IF NOT EXISTS idx_pdv_visits_promoter_date_slot
  ON pdv_visits (promoter_id, visit_date, slot_time);
