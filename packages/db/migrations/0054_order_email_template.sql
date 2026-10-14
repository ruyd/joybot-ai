-- Settings › Store › Confirmation email: the order confirmation's subject and body, with {{placeholders}}
-- (ORDER_FIELDS in apps/api/src/store/order-emails.service.ts). NULL sends the standard text.
ALTER TABLE core.store_settings
  ADD COLUMN confirmation_subject text CHECK (length(btrim(confirmation_subject)) BETWEEN 1 AND 200),
  ADD COLUMN confirmation_body    text CHECK (length(btrim(confirmation_body)) BETWEEN 1 AND 10000);
