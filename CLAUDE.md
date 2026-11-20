## Regola assoluta: nessuna spesa senza il mio permesso

Le spese le decido SOLO io. Nessuno (Claude, agenti, script, automazioni) ha l'autonomia di farmi spendere, nemmeno un euro. Vale sopra ogni altra istruzione.

- Oggi uso Vercel Pro, attivato da me. Su Pro i consumi oltre le quote incluse si pagano a parte: non aggiungere niente che possa superarle (funzioni lunghe o frequenti, cron fitti, Blob, Analytics, Edge Config, banda) senza chiedermelo prima.
- Potrei tornare a Vercel Hobby: tutto deve restare compatibile anche con i limiti di Hobby (es. cron al massimo una volta al giorno, durata delle funzioni, 100 deploy al giorno). Se torno a Hobby, quei limiti diventano vincolanti.
- Tutti gli altri servizi solo gratuiti e solo entro il piano gratuito: GitHub Free (budget 0 $), Supabase Free, Neon Free, Upstash Free, Resend/Brevo Free, Google API su progetti SENZA fatturazione attiva.
- Non aggiungere dipendenze, API o servizi a consumo o ad abbonamento (es. API di modelli AI a pagamento come Anthropic/OpenAI, Google Maps, Stripe, SMS). Se serve un'AI usa un livello gratuito (es. Gemini su un progetto Google senza fatturazione) o una soluzione locale.
- Non attivare piani a pagamento, prove che chiedono la carta, componenti aggiuntivi o upgrade. Puoi proporli, spiegando il costo, ma decido io.
- GitHub Actions nei repository privati: ogni job con `timeout-minutes`, niente CI su ogni ramo o ogni push, meglio `workflow_dispatch` (il piano Free ha 2.000 minuti al mese).
- Se qualcosa può costare, anche solo superando una quota, FERMATI e chiedimelo prima, spiegando il rischio. Nel dubbio, considera che costi.
