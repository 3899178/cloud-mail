-- Operator-applied additive CHECK guard for atomic public bulk registration. No retained rows or user data.
CREATE TABLE IF NOT EXISTS registration_admission_guard(admitted INTEGER NOT NULL CHECK(admitted=1));
