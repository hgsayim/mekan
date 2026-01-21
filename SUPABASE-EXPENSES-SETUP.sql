-- Supabase'de expenses tablosunu oluşturmak için bu SQL'i çalıştırın
-- Supabase Dashboard > SQL Editor > New Query'e yapıştırıp çalıştırın

-- Expenses tablosunu oluştur
CREATE TABLE IF NOT EXISTS expenses (
    id BIGSERIAL PRIMARY KEY,
    description TEXT NOT NULL,
    amount NUMERIC(10, 2) NOT NULL CHECK (amount >= 0),
    category TEXT NOT NULL,
    expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Updated_at için trigger oluştur (otomatik güncelleme için)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_expenses_updated_at
    BEFORE UPDATE ON expenses
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- RLS (Row Level Security) politikalarını etkinleştir
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;

-- Authenticated kullanıcılar için SELECT, INSERT, UPDATE, DELETE izinleri
CREATE POLICY "Users can view expenses"
    ON expenses FOR SELECT
    USING (auth.role() = 'authenticated');

CREATE POLICY "Users can insert expenses"
    ON expenses FOR INSERT
    WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Users can update expenses"
    ON expenses FOR UPDATE
    USING (auth.role() = 'authenticated')
    WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Users can delete expenses"
    ON expenses FOR DELETE
    USING (auth.role() = 'authenticated');

-- Index'ler (performans için)
CREATE INDEX IF NOT EXISTS idx_expenses_expense_date ON expenses(expense_date DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category);
CREATE INDEX IF NOT EXISTS idx_expenses_created_at ON expenses(created_at DESC);
