/**
 * Runtime integrations configuration.
 * Firebase browser configuration and EmailJS public keys are intentionally
 * public; access must be protected by Firebase/EmailJS rules.
 */
window.APP_CONFIG = Object.freeze({
  firebase: {
    apiKey: "AIzaSyDxus8eaWW4LwuVGpjDbcQzCgpZ_a24FIs",
    authDomain: "studio-a-bilheteria.firebaseapp.com",
    databaseURL: "https://studio-a-bilheteria-default-rtdb.firebaseio.com",
    projectId: "studio-a-bilheteria",
    storageBucket: "studio-a-bilheteria.firebasestorage.app",
    messagingSenderId: "371734227809",
    appId: "1:371734227809:web:a1cb5173dc99cfe2223320"
  },
  emailjs: {
    publicKey: "ydizgI42ecpxdKoaO",
    serviceId: "service_t43h6mj",
    templateId: "template_z2092tx"
  }
});
