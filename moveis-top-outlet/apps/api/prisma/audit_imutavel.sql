-- Impede UPDATE e DELETE na tabela audit_log (log imutável). Pode ser executado várias vezes.
CREATE OR REPLACE FUNCTION audit_log_imutavel() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log é imutável: alteração e exclusão não são permitidas';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_sem_alteracao ON audit_log;
CREATE TRIGGER audit_log_sem_alteracao
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_imutavel();
