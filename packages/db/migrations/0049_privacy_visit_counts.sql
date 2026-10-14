-- The standard privacy policy page (0029) gets a section on website visit counts (0048). Only a page
-- whose text is still the standard one changes; a policy the business has edited is left as it is.
UPDATE core.site_pages
SET modules = jsonb_set(modules, '{0,html}', to_jsonb(replace(
      modules->0->>'html',
      '<h2>How we use it</h2>',
      '<h2>Visits to our website</h2><p>We count visits to this website to learn which pages are useful. We don''t use cookies or advertising trackers for this, and we don''t record who you are: we keep only daily totals, such as how many people visited each page, which website or campaign they came from, their country and the type of device. To avoid counting someone twice in a day we use a code made from their connection and browser, which changes every day and is deleted the next day.</p><h2>How we use it</h2>')))
WHERE slug = 'privacy-policy'
  AND modules->0->>'id' = 'privacy-text'
  AND modules->0->>'html' = '<h1>Privacy policy</h1><p>This policy explains what personal information we collect, why we collect it and how we protect it.</p><h2>What we collect</h2><p>Your name and contact details, your appointments and payments, and the messages you send us or our assistant.</p><h2>How we use it</h2><p>To provide our services: to book and remind you of appointments, to take payments, and to answer your questions. We don''t sell your information.</p><h2>Who we share it with</h2><p>Only the providers that help us run our service, such as payment processing, email and messaging, under agreements that protect your information.</p><h2>How long we keep it</h2><p>As long as you''re a customer, and afterwards only as long as the law requires.</p><h2>Your choices</h2><p>You can see and update your details in your account, and ask us to correct or delete your information.</p><h2>Contact</h2><p>Questions about your privacy? <a href="/contact">Contact us</a>.</p>';
