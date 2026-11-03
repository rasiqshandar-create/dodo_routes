/* Team connection, built into the site so nobody has to configure anything.
   scriptUrl: the Apps Script Web App URL ending in /exec (no "/a/<domain>/" part)
   token:     the UPLOAD_TOKEN from Apps Script → Project Settings → Script properties
   Leave both empty to make people connect with a link or in Settings instead.
   NOTE: anyone who can open this site can then use the team workspace. */
window.DODO_CONFIG = {
  scriptUrl: '',
  token: ''
};
