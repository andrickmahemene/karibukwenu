# Karibu Kwenu – site de commande (version avec connexion)

## Contenu
- `server.js` : le serveur (aucune installation de bibliothèque nécessaire)
- `public/index.html` : le site (clients + espace équipe)
- `config.default.json` : menu, accompagnements, frais et horaires de départ
- `package.json`

## Mots de passe (obligatoires)
Définis dans Render, jamais dans le code : `ADMIN_PASS`, `CUISINE_PASS`, `LIVREUR_PASS`.
Un profil sans mot de passe ne peut pas se connecter.

## Déploiement sur Render
1. Mettre ces fichiers sur GitHub (dépôt privé conseillé).
2. Render : New + > Web Service > choisir le dépôt.
   - Runtime : Node. Build Command : laisser vide (ou `echo ok`). Start Command : `node server.js`.
   - Type d'instance : Starter (payant). Le plan gratuit efface les données à chaque redémarrage.
3. Onglet Disks > Add Disk : Mount Path `/var/data`, 1 GB.
4. Onglet Environment :
   - `DATA_DIR` = `/var/data`
   - `ADMIN_PASS`, `CUISINE_PASS`, `LIVREUR_PASS` = vos mots de passe
   - `SECRET` = une longue phrase au hasard
   - `DEMO_PAYMENTS` = `1` (paiements simulés) ; mettre `0` quand Orange Money sera branché
5. Deploy. Espace équipe : lien « Espace équipe » en bas du site.

## Ce qui reste à faire
- Brancher Orange Money : remplacer la fonction `payDemo` de `server.js` par la confirmation de paiement envoyée par l'opérateur (même vérifications : référence, montant, doublons).
- Notifications SMS / WhatsApp.
