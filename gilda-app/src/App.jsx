import { useCallback, useState, useEffect, useMemo, useRef, useId } from 'react';
import Papa from 'papaparse';
import 'leaflet/dist/leaflet.css';

const solicitudesPortadaEnCurso = new Map();
const csvCorrectoPorUrl = new Map();
const reintentarCsvTras = new Map();
const geocodificacionesEnCurso = new Map();
const respuestasJsonExternas = new Map();
const solicitudesJsonExternas = new Map();
const GOOGLE_BOOKS_COOLDOWN_KEY = 'gilda_google_books_cooldown';
let colaGeocodificacion = Promise.resolve();
let ultimaSolicitudGeocodificacion = 0;
const EMAIL_ADMINISTRADORA = 'ndnagore@gmail.com';

const googleBooksEnCooldown = () => {
  try {
    googleBooksCooldownUntil = Math.max(googleBooksCooldownUntil, Number(sessionStorage.getItem(GOOGLE_BOOKS_COOLDOWN_KEY)) || 0);
  } catch {
    // Continuar sin sessionStorage.
  }
  return googleBooksCooldownUntil > Date.now();
};

let googleBooksCooldownUntil = 0;

const solicitarJsonExterno = (url) => {
  const esGoogleBooks = url.includes('googleapis.com/books/');
  const ahora = Date.now();
  const cache = respuestasJsonExternas.get(url);
  if (cache && cache.expiresAt > ahora) return Promise.resolve(cache.data);
  if (esGoogleBooks && googleBooksEnCooldown()) return Promise.resolve(null);
  if (solicitudesJsonExternas.has(url)) return solicitudesJsonExternas.get(url);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  const solicitud = fetch(url, { signal: controller.signal })
    .then(async respuesta => {
      if (!respuesta.ok) {
        const error = new Error(`HTTP ${respuesta.status}`);
        error.status = respuesta.status;
        throw error;
      }
      return respuesta.json();
    })
    .then(data => {
      respuestasJsonExternas.set(url, { data, expiresAt: Date.now() + 10 * 60 * 1000 });
      return data;
    })
    .catch(error => {
      const espera = error.status === 429 ? 60000 : 30000;
      respuestasJsonExternas.set(url, { data: null, expiresAt: Date.now() + espera });
      if (esGoogleBooks && error.status === 429) {
        googleBooksCooldownUntil = Date.now() + espera;
        try {
          sessionStorage.setItem(GOOGLE_BOOKS_COOLDOWN_KEY, String(googleBooksCooldownUntil));
        } catch {
          // Continuar sin sessionStorage.
        }
      }
      return null;
    })
    .finally(() => {
      clearTimeout(timeout);
      solicitudesJsonExternas.delete(url);
    });

  if (respuestasJsonExternas.size > 50) respuestasJsonExternas.delete(respuestasJsonExternas.keys().next().value);
  solicitudesJsonExternas.set(url, solicitud);
  return solicitud;
};

const normalizarUbicacion = (texto) => String(texto || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()
  .toLowerCase()
  .replace(/\s+/g, ' ');

const formatearPais = (pais) => {
  const valor = String(pais || '').trim();
  const normalizado = normalizarUbicacion(valor);
  const alias = {
    es: 'España',
    espana: 'España',
    spain: 'España',
    us: 'Estados Unidos',
    usa: 'Estados Unidos',
    gb: 'Reino Unido',
    uk: 'Reino Unido'
  };
  if (alias[normalizado]) return alias[normalizado];
  if (/^[a-z]{2}$/i.test(valor) && typeof Intl.DisplayNames === 'function') {
    try {
      return new Intl.DisplayNames(['es'], { type: 'region' }).of(valor.toUpperCase()) || valor;
    } catch {
      return valor.toUpperCase();
    }
  }
  return valor.split(/\s+/).map(palabra => palabra.charAt(0).toLocaleUpperCase('es') + palabra.slice(1)).join(' ');
};

const normalizarResultadoGeo = (resultado) => {
  if (Array.isArray(resultado)) return { coords: resultado, country: '', region: '' };
  if (!resultado || !Array.isArray(resultado.coords)) return null;
  return resultado;
};

const geocodificarUbicacion = (consulta) => {
  const cacheKey = `gilda_geo_${normalizarUbicacion(consulta)}`;
  try {
    const cache = sessionStorage.getItem(cacheKey);
    if (cache !== null) return Promise.resolve(normalizarResultadoGeo(JSON.parse(cache)));
  } catch {
    // La geocodificacion sigue funcionando si sessionStorage no esta disponible.
  }

  if (geocodificacionesEnCurso.has(cacheKey)) return geocodificacionesEnCurso.get(cacheKey);

  const solicitud = colaGeocodificacion.then(async () => {
    try {
      const cache = sessionStorage.getItem(cacheKey);
      if (cache !== null) return normalizarResultadoGeo(JSON.parse(cache));
    } catch {
      // Continuar sin cache.
    }

    const espera = Math.max(0, 1100 - (Date.now() - ultimaSolicitudGeocodificacion));
    if (espera > 0) await new Promise(resolve => setTimeout(resolve, espera));
    ultimaSolicitudGeocodificacion = Date.now();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=1&q=${encodeURIComponent(consulta)}`;
      const respuesta = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
      if (!respuesta.ok) throw new Error(`Geocoding HTTP ${respuesta.status}`);
      const resultados = await respuesta.json();
      const resultado = resultados[0];
      const coordenadas = resultado ? [Number(resultado.lat), Number(resultado.lon)] : null;
      const validas = coordenadas && coordenadas.every(Number.isFinite)
        ? {
            coords: coordenadas,
            country: resultado.address?.country || '',
            region: resultado.address?.state || resultado.address?.region || ''
          }
        : null;
      try {
        sessionStorage.setItem(cacheKey, JSON.stringify(validas));
      } catch {
        // Ignorar errores de almacenamiento.
      }
      return validas;
    } catch {
      try {
        sessionStorage.setItem(cacheKey, 'null');
      } catch {
        // Ignorar errores de almacenamiento.
      }
      return null;
    } finally {
      clearTimeout(timeout);
    }
  });

  colaGeocodificacion = solicitud.then(() => undefined, () => undefined);
  geocodificacionesEnCurso.set(cacheKey, solicitud);
  solicitud.finally(() => geocodificacionesEnCurso.delete(cacheKey));
  return solicitud;
};

export default function App() {
  const BuscadorLibrosEstable = useMemo(() => BuscadorLibros, []);
  const PortadaLibroEstable = useMemo(() => PortadaLibro, []);
  const MapaGildaEstable = useMemo(() => MapaGilda, []);

  // Utilidades seguras para localStorage
  const safeGet = (key, fallback) => {
    try {
      const val = localStorage.getItem(key);
      return val !== null ? val : fallback;
    } catch {
      return fallback;
    }
  };

  const safeGetJSON = (key, fallback) => {
    try {
      const val = localStorage.getItem(key);
      if (val === null) return fallback;
      const parsed = JSON.parse(val);
      if (Array.isArray(fallback)) return Array.isArray(parsed) ? parsed : fallback;
      if (fallback === null) {
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
      }
      return typeof parsed === typeof fallback ? parsed : fallback;
    } catch {
      return fallback;
    }
  };

  const safeSet = (key, val) => {
    try {
      localStorage.setItem(key, typeof val === 'string' ? val : JSON.stringify(val));
    } catch (e) {
      console.error(e);
    }
  };

  const safeRemove = (key) => {
    try {
      localStorage.removeItem(key);
    } catch (e) {
      console.error(e);
    }
  };

  const GOOGLE_API_URL = 'https://script.google.com/macros/s/AKfycbyHpjY_aWLhx9QQi8wLxgSITi9Uw5jerIagBmtVI3OSkntDkm7_vhrA0Ybvzuv5ymI/exec';
  const URL_CSV_USUARIAS = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQjlrJeQOX8jACYNfkrjZoVxWkOXPj1AQu2dfj85057_1XeIetRvMT6hflk0ne6fCoY9_JU-qBn2xO8/pub?gid=0&single=true&output=csv';
  const URL_CSV_CAPITULOS = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQjlrJeQOX8jACYNfkrjZoVxWkOXPj1AQu2dfj85057_1XeIetRvMT6hflk0ne6fCoY9_JU-qBn2xO8/pub?gid=1060479353&single=true&output=csv';
  const URL_CSV_COMENTARIOS = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQjlrJeQOX8jACYNfkrjZoVxWkOXPj1AQu2dfj85057_1XeIetRvMT6hflk0ne6fCoY9_JU-qBn2xO8/pub?gid=1626426174&single=true&output=csv';
  const URL_CSV_LECTURAS = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQjlrJeQOX8jACYNfkrjZoVxWkOXPj1AQu2dfj85057_1XeIetRvMT6hflk0ne6fCoY9_JU-qBn2xO8/pub?gid=1676533026&single=true&output=csv';
  const URL_CSV_CHAT = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQjlrJeQOX8jACYNfkrjZoVxWkOXPj1AQu2dfj85057_1XeIetRvMT6hflk0ne6fCoY9_JU-qBn2xO8/pub?gid=456334295&single=true&output=csv';
  const URL_CSV_PROPUESTAS = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQjlrJeQOX8jACYNfkrjZoVxWkOXPj1AQu2dfj85057_1XeIetRvMT6hflk0ne6fCoY9_JU-qBn2xO8/pub?gid=1701531859&single=true&output=csv';
  const URL_CSV_LECTURAS_PERSONALES = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQjlrJeQOX8jACYNfkrjZoVxWkOXPj1AQu2dfj85057_1XeIetRvMT6hflk0ne6fCoY9_JU-qBn2xO8/pub?gid=1089788162&single=true&output=csv';
  const URL_CSV_CALENDARIO = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQjlrJeQOX8jACYNfkrjZoVxWkOXPj1AQu2dfj85057_1XeIetRvMT6hflk0ne6fCoY9_JU-qBn2xO8/pub?gid=2016923063&single=true&output=csv';
  const URL_CSV_MURO = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQjlrJeQOX8jACYNfkrjZoVxWkOXPj1AQu2dfj85057_1XeIetRvMT6hflk0ne6fCoY9_JU-qBn2xO8/pub?gid=802798011&single=true&output=csv';
  const URL_CSV_CAFECITOS = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQjlrJeQOX8jACYNfkrjZoVxWkOXPj1AQu2dfj85057_1XeIetRvMT6hflk0ne6fCoY9_JU-qBn2xO8/pub?gid=1040100079&single=true&output=csv';
  const URL_CSV_VOTACION_CAFE = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQjlrJeQOX8jACYNfkrjZoVxWkOXPj1AQu2dfj85057_1XeIetRvMT6hflk0ne6fCoY9_JU-qBn2xO8/pub?gid=933058441&single=true&output=csv';
  const FRASES_INICIALES = [
    "Un lector vive mil vidas antes de morir. El que no lee vive solo una.",
    "La depresión... como la manifestación de algo que no se puede reducir a lo anecdótico porque es estructural y colectivo.",
    "No hay barrera, cerradura ni cerrojo que puedas imponer a la libertad de mi mente."
  ];

  const calcularEstadoConexion = (timestampStr) => {
    if (!timestampStr) return 'desconectada';
    const ahora = new Date();
    const ultima = new Date(timestampStr);
    const diffMinutos = (ahora - ultima) / 1000 / 60;
    if (isNaN(diffMinutos)) return 'desconectada';
    if (diffMinutos < 3) return 'conectada';
    if (diffMinutos < 15) return 'ausente';
    return 'desconectada';
  };

  const IndicadorPresencia = ({ timestamp }) => {
    const estado = calcularEstadoConexion(timestamp);
    if (estado === 'desconectada') return <span className="w-2.5 h-2.5 rounded-full bg-gray-300 inline-block shrink-0" title="Desconectada"></span>;
    const color = estado === 'conectada' ? 'bg-green-500 animate-pulse' : 'bg-amber-400';
    const titulo = estado === 'conectada' ? 'Conectada ahora' : 'Ausente';
    return <span className={`w-2.5 h-2.5 rounded-full ${color} inline-block shrink-0`} title={titulo}></span>;
  };

  const formatearHoraWhatsApp = (timestampOrStr, fechaFallback) => {
    if (timestampOrStr) {
      const d = new Date(timestampOrStr);
      if (!isNaN(d.getTime())) {
        const horas = String(d.getHours()).padStart(2, '0');
        const minutos = String(d.getMinutes()).padStart(2, '0');
        return `${horas}:${minutos}`;
      }
    }
    if (fechaFallback && fechaFallback !== 'Justo ahora') {
      const match = fechaFallback.match(/\b(\d{1,2}):(\d{2})(?::\d{2})?\b/);
      if (match) {
        return `${match[1].padStart(2, '0')}:${match[2]}`;
      }
    }
    const ahora = new Date();
    return `${String(ahora.getHours()).padStart(2, '0')}:${String(ahora.getMinutes()).padStart(2, '0')}`;
  };

  function ModalCompartirStory({ onClose, usuario, libro, pagina, citas, decoracion, misLibros, onPublicarCita }) {
    const [modo, setModo] = useState('progreso'); 
    const [textoCita, setTextoCita] = useState(FRASES_INICIALES[0]);
    const [tituloLibroStory, setTituloLibroStory] = useState(libro?.titulo || '');
    const [publicandoCita, setPublicandoCita] = useState(false);
    useEffect(() => {
      if (citas?.length) setTextoCita(citas[Math.floor(Math.random() * citas.length)]);
    }, [citas]);
    const librosStory = useMemo(() => {
      const candidatos = [libro, ...misLibros].filter(item => item?.titulo || item?.libro);
      const unicos = new Map();
      candidatos.forEach(item => {
        const titulo = String(item.titulo || item.libro || '').trim();
        if (!titulo) return;
        const clave = titulo.toLowerCase();
        if (!unicos.has(clave)) unicos.set(clave, { ...item, titulo });
      });
      return [...unicos.values()];
    }, [libro, misLibros]);
    const libroStory = librosStory.find(item => item.titulo === tituloLibroStory) || librosStory[0] || libro;
    const paginaStory = Number(libroStory?.pagina ?? libroStory?.paginas ?? pagina) || 0;

    const elegirOtraCita = () => {
      const opciones = citas?.length ? citas : FRASES_INICIALES;
      setTextoCita(opciones[Math.floor(Math.random() * opciones.length)]);
    };

    const handleDownload = () => {
      const el = document.getElementById('gilda-story-card');
      if (window.html2canvas) {
        window.html2canvas(el, { 
          scale: 3, 
          useCORS: true, 
          allowTaint: true, 
          backgroundColor: '#ffffee',
          logging: false,
          onclone: (clonedDoc) => {
            const clonedCard = clonedDoc.getElementById('gilda-story-card');
            if (clonedCard) {
              clonedCard.style.width = '310px';
              clonedCard.style.height = '551px';
            }
          }
        }).then(canvas => {
          const link = document.createElement('a');
          link.download = `gilda_story_${modo}.png`;
          link.href = canvas.toDataURL('image/png');
          link.click();
        }).catch(err => {
          console.error("Error al generar la imagen:", err);
          alert("Hubo un error al generar la imagen. Intenta hacer captura de pantalla.");
        });
      }
    };

    const nombreSocia = (
      usuario && String(usuario).trim() !== '' 
        ? String(usuario).trim() 
        : 'socia'
    ).toLowerCase();

    return (
      <div className="fixed inset-0 z-[99999] bg-black/70 backdrop-blur-sm flex flex-col items-center justify-start pt-6 pb-6 px-4 fade-in overflow-y-auto">
        <div className="flex bg-white/10 backdrop-blur-md p-1 rounded-full mb-4 border border-white/20 shadow-lg shrink-0">
           <button onClick={() => setModo('progreso')} className={`px-4 py-2 text-[10px] uppercase tracking-widest font-bold rounded-full transition-colors ${modo==='progreso' ? 'bg-white text-[#1c1c1a] shadow-sm':'text-white hover:bg-white/10'}`}>Progreso</button>
           <button onClick={() => setModo('cita')} className={`px-4 py-2 text-[10px] uppercase tracking-widest font-bold rounded-full transition-colors ${modo==='cita' ? 'bg-white text-[#1c1c1a] shadow-sm':'text-white hover:bg-white/10'}`}>Cita</button>
           <button onClick={() => setModo('habitacion')} className={`px-4 py-2 text-[10px] uppercase tracking-widest font-bold rounded-full transition-colors ${modo==='habitacion' ? 'bg-white text-[#1c1c1a] shadow-sm':'text-white hover:bg-white/10'}`}>Habitación</button>
        </div>

        {librosStory.length > 0 && (
          <label className="w-full max-w-[310px] mb-3 flex items-center gap-2 text-xs font-sans text-white shrink-0">
            <span className="font-bold">Libro</span>
            <select value={libroStory.titulo} onChange={e => setTituloLibroStory(e.target.value)} className="min-w-0 flex-grow bg-white text-[#1c1c1a] border border-white/30 rounded-lg px-2.5 py-2 text-xs">
              {librosStory.map(item => <option key={item.titulo} value={item.titulo}>{item.titulo}</option>)}
            </select>
          </label>
        )}

        <div 
          id="gilda-story-card" 
          className="relative w-[310px] h-[551px] shadow-2xl rounded-2xl flex flex-col justify-between items-center p-6 bg-[#ffffee] border border-[#e6e4dc] shrink-0 box-border overflow-hidden" 
        >
          <div className="w-full text-center pt-2 pb-2 shrink-0">
            <h2 className="font-babydoll text-xl text-[#1c1c1a] leading-tight tracking-wide">
              la habitación de {nombreSocia}
            </h2>
          </div>
          
          <div className="w-full flex-grow flex flex-col items-center justify-center py-2 box-border">
            {modo === 'cita' && (
              <div className="w-full px-2 text-center flex flex-col items-center justify-center space-y-3">
                <textarea aria-label="Texto de la cita para Stories" value={textoCita} onChange={e => setTextoCita(e.target.value)} maxLength={360} className="w-full min-h-36 resize-none border border-[#e6e4dc] rounded-xl bg-white/70 p-3 font-babydoll text-base text-[#1c1c1a] leading-relaxed text-center focus:outline-none focus:ring-2 focus:ring-[#8b6040]" />
                <button type="button" onClick={elegirOtraCita} className="text-[10px] font-bold text-[#3d4220] bg-white border border-[#e6e4dc] rounded-full px-3 py-1.5">Otra cita</button>
                {libroStory?.titulo && <span className="font-sans text-[10px] text-[#595750]">{libroStory.titulo}{libroStory.autora ? ` · ${libroStory.autora}` : ''}</span>}
                <span className="font-sans text-xs font-semibold text-[#3d4220] tracking-wide block lowercase">
                  @gilda.mailclub
                </span>
              </div>
            )}
            
            {modo === 'progreso' && (
              <div className="w-full flex flex-col items-center text-center space-y-3">
                <span className="font-sans text-xs font-semibold text-[#3d4220] tracking-wide block lowercase">
                  @gilda.mailclub
                </span>
                
                <div className="shadow-xl w-20 h-28 rounded overflow-hidden shrink-0 flex items-center justify-center bg-gray-100">
                  <PortadaLibroEstable titulo={libroStory.titulo} autora={libroStory.autora} portada={libroStory.portada} size="story" />
                </div>

                <div className="w-full max-w-[210px] space-y-1.5 pt-1">
                  <p className="font-babydoll font-bold text-sm leading-snug text-[#1c1c1a] px-1 m-0 text-center">
                    {libroStory.titulo}
                  </p>
                  
                  <div className="w-full bg-[#e6e4dc] h-[4px] rounded-full overflow-hidden my-1">
                    <div 
                      className="bg-[#3d4220] h-full rounded-full" 
                      style={{ width: `${Math.min(100, Math.max(5, (paginaStory / (libroStory.paginas_totales || libro.paginas_totales || 280)) * 100))}%` }}
                    ></div>
                  </div>

                  <p className="text-[11px] text-[#595750] font-sans font-bold tracking-wide m-0 text-center">
                    pág. {paginaStory}
                  </p>
                </div>
              </div>
            )}
            
            {modo === 'habitacion' && (
              <div className="w-full flex flex-col items-center justify-center">
                <div className="estanteria-madera w-[240px] flex items-end justify-center px-2 pt-4 pb-6 min-h-[130px] shadow-sm relative box-border">
                  {misLibros.slice(0, 4).map((item, idx) => (
                    <div key={idx} className="scale-75 transform origin-bottom -mx-2.5 shrink-0">
                      <LomoLibroEstanteria item={item} />
                    </div>
                  ))}
                  {decoracion !== 'ninguna' && (
                    <div className="shrink-0 pl-1 pb-1 scale-75 transform origin-bottom">
                      <IlustracionDecoracion tipo={decoracion} />
                    </div>
                  )}
                  
                  <span className="absolute bottom-1 right-2 font-sans text-[10px] font-bold text-[#3d4220] tracking-wide block lowercase z-10">
                    @gilda.mailclub
                  </span>
                </div>
              </div>
            )}
          </div>

          <div className="w-full h-4 shrink-0"></div>
        </div>

        <div className="mt-5 space-y-2.5 w-full max-w-[310px] shrink-0 font-sans">
           {modo === 'cita' && (
             <button
               type="button"
               disabled={!textoCita.trim() || publicandoCita}
               onClick={async () => {
                 setPublicandoCita(true);
                 try {
                   await onPublicarCita?.(textoCita.trim(), libroStory);
                 } finally {
                   setPublicandoCita(false);
                 }
               }}
               className="w-full bg-[#3d4220] text-white font-bold py-3.5 rounded-2xl text-xs shadow-xl flex items-center justify-center gap-2 disabled:opacity-50"
             >
               <i className="fa-solid fa-feather"></i> {publicandoCita ? 'Publicando...' : 'Publicar en el Muro'}
             </button>
           )}
           <button onClick={handleDownload} className="w-full bg-white text-[#1c1c1a] font-bold py-3.5 rounded-2xl text-xs shadow-xl flex items-center justify-center gap-2 hover:scale-[1.02] transition-transform">
             <i className="fa-solid fa-download"></i> Descargar imagen
           </button>
           <button onClick={onClose} className="w-full bg-transparent text-white font-bold py-3.5 rounded-2xl text-xs border border-white/20 hover:bg-white/10 transition-colors">
             Cerrar
           </button>
           <p className="text-center text-white/70 text-xs px-4 pt-1 leading-relaxed">
             Consejo: También puedes hacer captura de pantalla para subirla directamente a tus Stories.
           </p>
        </div>
      </div>
    );
  }

  function ModalUpgrade({ onClose }) {
    return (
      <div className="fixed inset-0 z-[99999] bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 fade-in">
        <div className="editorial-card max-w-sm w-full p-6 space-y-4 text-center bg-white relative">
          <button onClick={onClose} className="absolute top-3 right-3 text-gray-400 hover:text-black">
            <i className="fa-solid fa-xmark text-sm"></i>
          </button>
          <div className="w-12 h-12 bg-[#ffffee] rounded-full flex items-center justify-center mx-auto text-[#3d4220] border border-[#e6e4dc]">
            <i className="fa-solid fa-lock text-lg"></i>
          </div>
          <div className="space-y-1">
            <h3 className="font-babydoll text-xl font-bold">Acceso restringido</h3>
            <p className="text-xs text-[#595750] font-sans leading-relaxed">
              Tu modalidad actual no incluye acceso a esta función. Actualiza tu suscripción para acceder a todas las secciones de gilda.
            </p>
          </div>
          <a href="https://nagoreads.github.io/gilda/" target="_blank" rel="noopener noreferrer" className="block w-full editorial-btn py-2.5 text-xs text-center font-semibold">
            Actualizar modalidad
          </a>
        </div>
      </div>
    );
  }

  function ObjetoExternoEnmarcado({ urlImagen, titulo, onClick }) {
    const estiloImagenExterna = {
      filter: 'saturate(0.8) sepia(0.2) contrast(0.9)',
      objectFit: 'cover'
    };

    return (
      <button 
        onClick={onClick}
        className="relative cursor-pointer hover:scale-105 transition-transform shrink-0"
        title={titulo || "Pin importado"}
      >
        <div className="border-[1.5px] border-[#1c1c1a] rounded-sm bg-[#f7f3e8] p-1 shadow-sm w-16 h-20 flex flex-col items-center">
          <div className="absolute top-0 w-2 h-3 bg-[#595750] border-[1px] border-[#1c1c1a] rounded-full z-10 -mt-1"></div>
          <div className="w-full h-full overflow-hidden border-[1px] border-[#1c1c1a]">
            {urlImagen ? (
              <img src={urlImagen} alt={titulo} style={estiloImagenExterna} className="w-full h-full" />
            ) : (
              <div className="w-full h-full bg-[#e8e2d2] flex items-center justify-center">
                 <span className="text-[#595750] text-[10px] text-center font-sans">+ Pin</span>
              </div>
            )}
          </div>
        </div>
      </button>
    );
  }

  function ModalImportarPin({ onClose, onSave }) {
    const [urlInput, setUrlInput] = useState('');
    const [tituloInput, setTituloInput] = useState('');

    return (
      <div className="fixed inset-0 z-[99999] bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 fade-in">
        <div className="editorial-card max-w-sm w-full p-6 space-y-4 bg-white relative">
          <button onClick={onClose} className="absolute top-3 right-3 text-gray-400 hover:text-black">
            <i className="fa-solid fa-xmark text-sm"></i>
          </button>
          <h3 className="font-babydoll text-xl font-bold">Añadir pin o imagen externa</h3>
          <p className="text-xs text-[#595750] font-sans leading-relaxed">
            Pega la URL directa de la imagen (ej. de Pinterest o Cosmos).
          </p>
          <div className="space-y-3 font-sans">
            <div>
              <label className="block text-xs font-semibold text-[#1c1c1a] mb-1">Título del marco o moodboard</label>
              <input type="text" placeholder="Ej: Inspiración otoño..." value={tituloInput} onChange={(e) => setTituloInput(e.target.value)} className="w-full editorial-input p-2.5 text-xs" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-[#1c1c1a] mb-1">URL directa de la imagen (.jpg, .png)</label>
              <input type="url" placeholder="https://..." value={urlInput} onChange={(e) => setUrlInput(e.target.value)} className="w-full editorial-input p-2.5 text-xs" />
            </div>
          </div>
          <div className="flex gap-2 pt-2">
            <button onClick={() => { if (urlInput.trim()) { onSave(urlInput.trim(), tituloInput.trim()); } }} className="flex-1 editorial-btn py-2.5 text-xs font-semibold">
              Guardar marco
            </button>
            <button onClick={onClose} className="flex-1 bg-gray-100 text-[#595750] rounded-xl py-2.5 text-xs font-semibold hover:bg-gray-200 font-sans">
              Cancelar
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Búsqueda con debounce integrado para la API de Google Books
  function BuscadorLibros({ placeholder, valor, setValor, onSelectLibro }) {
    const [sugerencias, setSugerencias] = useState([]);
    const [buscando, setBuscando] = useState(false);
    const [mostrarDropdown, setMostrarDropdown] = useState(false);

    useEffect(() => {
      let activo = true;
      if (!valor || valor.trim().length < 2) {
        setSugerencias([]);
        setMostrarDropdown(false);
        return () => { activo = false; };
      }
      const timer = setTimeout(async () => {
        setBuscando(true);
        try {
          const query = encodeURIComponent(valor.trim());
          const [dataG, dataOL] = await Promise.all([
            solicitarJsonExterno(`https://www.googleapis.com/books/v1/volumes?q=${query}&maxResults=8&printType=books&langRestrict=es`),
            solicitarJsonExterno(`https://openlibrary.org/search.json?q=${query}&limit=6&language=spa`)
          ]);
          if (!activo) return;
          let listaCombinada = [];
          if (dataG?.items) {
            dataG.items.forEach(item => {
              const info = item.volumeInfo || {};
              let thumb = info.imageLinks?.thumbnail || info.imageLinks?.smallThumbnail || '';
              if (thumb) {
                thumb = thumb.replace('http:', 'https:').replace('&edge=curl', '');
              }
              listaCombinada.push({ titulo: info.title || '', autora: info.authors ? info.authors.join(', ') : '', portada: thumb });
            });
          }
          if (dataOL?.docs) {
            dataOL.docs.forEach(doc => {
              listaCombinada.push({ titulo: doc.title || '', autora: doc.author_name ? doc.author_name.join(', ') : '', portada: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` : '' });
            });
          }
          const unicos = [];
          const titulosVistos = new Set();
          listaCombinada.forEach(item => {
            const tLimpio = item.titulo.toLowerCase().trim();
            if (tLimpio && !titulosVistos.has(tLimpio)) { 
              titulosVistos.add(tLimpio); 
              unicos.push(item); 
            }
          });
          setSugerencias(unicos.slice(0, 8));
          setMostrarDropdown(unicos.length > 0);
        } catch { 
          if (activo) setSugerencias([]);
        } finally {
          if (activo) setBuscando(false);
        }
      }, 500); // 500ms de debounce para evitar Error 429
      return () => {
        activo = false;
        clearTimeout(timer);
      };
    }, [valor]);

    return (
      <div className="relative w-full">
        <div className="relative flex items-center">
          <input type="text" placeholder={placeholder} value={valor} onChange={(e) => { setValor(e.target.value); setMostrarDropdown(true); }} className="w-full editorial-input p-2.5 text-xs italic pr-8" />
          {buscando && <i className="fa-solid fa-spinner animate-spin absolute right-2.5 text-xs text-[#3d4220]"></i>}
        </div>
        {mostrarDropdown && sugerencias.length > 0 && (
          <div className="absolute top-full left-0 right-0 z-50 bg-[#FFFFFF] border border-[#e6e4dc] rounded-b-xl shadow-xl max-h-56 overflow-y-auto mt-1">
            {sugerencias.map((item, idx) => (
              <div key={idx} onClick={() => { onSelectLibro(item); setMostrarDropdown(false); }} className="flex items-center gap-2.5 p-2 hover:bg-[#ffffee] cursor-pointer border-b border-[#e6e4dc] last:border-0 text-left">
                {item.portada ? <img src={`https://images.weserv.nl/?url=${encodeURIComponent(item.portada)}&w=100&output=jpg`} alt="" className="w-7 h-10 object-cover rounded shrink-0 shadow-sm" /> : <div className="w-7 h-10 bg-[#faf9f5] rounded shrink-0 flex items-center justify-center text-[7px] text-[#595750] border border-[#e6e4dc]">Sin foto</div>}
                <div className="overflow-hidden">
                  <p className="text-sm font-bold text-[#1c1c1a] truncate leading-tight font-babydoll">{item.titulo}</p>
                  <p className="text-[10px] text-[#595750] italic truncate font-sans">{item.autora || ''}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  function PortadaLibro({ titulo, autora, autor, escritora, portada, cover, image, size = 'normal' }) {
    const [errorImg, setErrorImg] = useState(false);
    const [portadaDinamica, setPortadaDinamica] = useState('');
    const [autoraEncontrada, setAutoraEncontrada] = useState('');
    const [, setBuscandoOnline] = useState(false);

    const sizeClasses = 
      size === 'story' ? 'w-full h-full text-xs min-h-[112px]' : 
      size === 'large' ? 'w-24 h-36 text-xs' : 
      size === 'grid' ? 'w-16 h-24 text-[9px]' : 
      size === 'thumb' ? 'w-10 h-14 text-[8px]' : 'w-12 h-16 text-[8px]';

    const portadaOriginal = portada || cover || image || '';
    const tituloFinal = titulo || 'Sin título';
    const autoraCruda = autora || autor || escritora || '';
    const autoraFinal = useMemo(() => {
      if (!autoraCruda || typeof autoraCruda !== 'string') return '';
      const aLimpia = autoraCruda.trim();
      const lower = aLimpia.toLowerCase();
      if (['autora', 'autor', 'desconocida', 'escritora', 'undefined', 'null'].includes(lower)) return '';
      return aLimpia;
    }, [autoraCruda]);

    useEffect(() => {
      let activo = true;
      if ((!portadaOriginal || errorImg || !autoraFinal) && tituloFinal && tituloFinal !== 'Sin título' && !portadaDinamica) {
        setBuscandoOnline(true);
        const cacheKey = `gilda_portada_${tituloFinal.trim().toLowerCase()}_${autoraFinal.trim().toLowerCase()}`;
        const leerCache = () => {
          try {
            const valor = sessionStorage.getItem(cacheKey);
            return valor ? JSON.parse(valor) : {};
          } catch {
            return {};
          }
        };
        const guardarCache = (fuente, estado, datos = null) => {
          try {
            const cache = leerCache();
            cache[fuente] = { estado, datos };
            sessionStorage.setItem(cacheKey, JSON.stringify(cache));
          } catch {
            // sessionStorage puede estar bloqueado en modo privado.
          }
        };
        const cargarFuente = async (fuente, url) => {
          const cache = leerCache()[fuente];
          if (cache?.estado === 'error') return null;
          if (cache?.estado === 'ok') return cache.datos;
          if (fuente === 'google' && googleBooksEnCooldown()) return null;

          const solicitudKey = `${cacheKey}:${fuente}`;
          const solicitudExistente = solicitudesPortadaEnCurso.get(solicitudKey);
          if (solicitudExistente) return solicitudExistente;

          const solicitud = solicitarJsonExterno(url)
            .then(datos => {
              if (datos === null) {
                guardarCache(fuente, 'error');
                return null;
              }
              guardarCache(fuente, 'ok', datos);
              return datos;
            })
            .finally(() => solicitudesPortadaEnCurso.delete(solicitudKey));

          solicitudesPortadaEnCurso.set(solicitudKey, solicitud);
          return solicitud;
        };

        const query = encodeURIComponent(`${tituloFinal} ${autoraFinal}`);
        Promise.all([
          cargarFuente('google', `https://www.googleapis.com/books/v1/volumes?q=${query}&maxResults=1&langRestrict=es`),
          cargarFuente('openLibrary', `https://openlibrary.org/search.json?q=${query}&limit=1&language=spa`)
        ]).then(([dataGoogle, dataOpenLibrary]) => {
          if (!activo) return;
          let imgEncontrada = '';
          let autEncontrada = '';
          const itemG = dataGoogle?.items?.[0]?.volumeInfo;
          if (itemG) {
            if (itemG.imageLinks?.thumbnail || itemG.imageLinks?.smallThumbnail) {
              imgEncontrada = itemG.imageLinks.thumbnail || itemG.imageLinks.smallThumbnail;
            }
            if (itemG.authors && itemG.authors.length > 0) autEncontrada = itemG.authors.join(', ');
          }
          const docOL = dataOpenLibrary?.docs?.[0];
          if (!imgEncontrada && docOL?.cover_i) imgEncontrada = `https://covers.openlibrary.org/b/id/${docOL.cover_i}-L.jpg`;
          if (!autEncontrada && docOL?.author_name?.length) autEncontrada = docOL.author_name.join(', ');
          if (imgEncontrada) {
            setPortadaDinamica(imgEncontrada.replace('http:', 'https:'));
          }
          if (autEncontrada && !autoraFinal) setAutoraEncontrada(autEncontrada);
        }).finally(() => { if (activo) setBuscandoOnline(false); });
      }
      return () => { activo = false; };
    }, [portadaOriginal, errorImg, tituloFinal, autoraFinal, portadaDinamica]);

    const urlSegura = useMemo(() => {
      const pFinal = portadaOriginal || portadaDinamica;
      if (!pFinal || typeof pFinal !== 'string') return '';
      let p = pFinal.trim();
      if (p.startsWith('data:image')) return p;
      if (p.startsWith('http://')) p = p.replace('http://', 'https://');
      if (p.startsWith('https://')) return `https://images.weserv.nl/?url=${encodeURIComponent(p)}&w=300&output=jpg`;
      return '';
    }, [portadaOriginal, portadaDinamica]);

    const autoraMostrar = autoraFinal || autoraEncontrada || '';
    const colorEditorialFallback = useMemo(() => {
      let hash = 0;
      for (let i = 0; i < tituloFinal.length; i++) { hash = tituloFinal.charCodeAt(i) + ((hash << 5) - hash); }
      const matices = ['#3d4220', '#34381b', '#523021', '#232820', '#633528', '#324854', '#543d30', '#3d3054', '#4a3429', '#324235'];
      return matices[Math.abs(hash) % matices.length];
    }, [tituloFinal]);

    if (urlSegura !== '' && !errorImg) {
      return <img src={urlSegura} alt={tituloFinal} onError={() => setErrorImg(true)} className={`${sizeClasses} object-cover rounded shadow-sm shrink-0 bg-gray-100`} />;
    }

    return (
      <div style={{ backgroundColor: colorEditorialFallback }} className={`${sizeClasses} text-[#ffffee] p-2 rounded shadow-sm border border-white/20 shrink-0 flex flex-col justify-between overflow-hidden text-left relative`}>
        <div className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-white/30"></div>
        <span className="font-bold tracking-tight line-clamp-3 leading-tight font-babydoll drop-shadow-sm" style={{ fontSize: (size === 'large' || size === 'story') ? '11px' : '9px' }}>
          {tituloFinal}
        </span>
        <span className="text-[7px] text-white/80 uppercase tracking-wider truncate font-sans">
          {autoraMostrar}
        </span>
      </div>
    );
  }

  function LomoLibroEstanteria({ item, onClick }) {
    const generarColorEditorial = (texto) => {
      let hash = 0;
      for (let i = 0; i < texto.length; i++) { hash = texto.charCodeAt(i) + ((hash << 5) - hash); }
      const matices = ['#3d4220', '#34381b', '#523021', '#232820', '#633528', '#324854', '#543d30', '#3d3054', '#4a3429', '#324235', '#523c2a', '#2c363d', '#422e2e', '#3a2e4a', '#323d3e'];
      return matices[Math.abs(hash) % matices.length];
    };
    const tituloLibro = item.libro || item.titulo || 'libro';

    return (
      <div onClick={onClick} style={{ backgroundColor: generarColorEditorial(tituloLibro) }} className="lomo-libro text-[#ffffee] w-12 h-36 shrink-0 cursor-pointer shadow-md relative rounded-t-sm overflow-hidden flex flex-col justify-start p-2 border-t border-white/20" title={`${tituloLibro} — ${item.autora || ''}`}>
        <div className="absolute top-1 left-1.5 w-1 h-2 rounded-full bg-white/20"></div>
        <div className="flex flex-col h-full justify-start pt-3">
          <span className="font-babydoll font-bold text-[9px] leading-tight text-left text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.5)] overflow-hidden" style={{writingMode: 'vertical-rl', textOrientation: 'mixed', maxHeight: '110px'}}>
            {tituloLibro}
          </span>
        </div>
      </div>
    );
  }

  function IlustracionDecoracion({ tipo, onInteractuar }) {
    const [animado, setAnimado] = useState(false);
    const handleClick = () => {
      setAnimado(true);
      setTimeout(() => setAnimado(false), 400);
      if (onInteractuar) onInteractuar(tipo);
    };
    const wrapperClass = `interactiva-ilustracion ${animado ? 'animar-salto' : ''}`;

    if (tipo === 'monstera') return (
      <div onClick={handleClick} className={wrapperClass} title="¡Haz clic en tu plantita!">
        <svg width="44" height="48" viewBox="0 0 42 46" fill="none" xmlns="http://www.w3.org/2000/svg" className="shrink-0 drop-shadow-sm">
          <path d="M14 34H28V44H14V34Z" fill="#b8784f" stroke="#1c1c1a" strokeWidth="1.5"/><path d="M12 34H30V37H12V34Z" fill="#9e6037" stroke="#1c1c1a" strokeWidth="1.5"/><path d="M21 34V16" stroke="#3d4220" strokeWidth="2" strokeLinecap="round"/><path d="M21 22C14 20 8 24 6 28C11 31 16 28 21 22Z" fill="#616c31" stroke="#1c1c1a" strokeWidth="1.5"/><path d="M21 18C28 16 34 20 36 24C31 27 26 24 21 18Z" fill="#525c27" stroke="#1c1c1a" strokeWidth="1.5"/><path d="M21 14C17 6 10 6 7 9C10 13 15 14 21 14Z" fill="#758237" stroke="#1c1c1a" strokeWidth="1.5"/><path d="M21 14C25 6 32 6 35 9C32 13 27 14 21 14Z" fill="#616c31" stroke="#1c1c1a" strokeWidth="1.5"/>
        </svg>
      </div>
    );
    if (tipo === 'maceta') return (
      <div onClick={handleClick} className={wrapperClass} title="¡Haz clic en tu maceta!">
        <svg width="42" height="44" viewBox="0 0 40 42" fill="none" xmlns="http://www.w3.org/2000/svg" className="shrink-0 drop-shadow-sm">
          <path d="M10 28H30V40H10V28Z" fill="#d4c8b4" stroke="#1c1c1a" strokeWidth="1.5"/><path d="M8 25H32V29H8V25Z" fill="#e3d9cc" stroke="#1c1c1a" strokeWidth="1.5"/><path d="M20 25C15 16 11 10 9 6C15 10 18 16 20 25Z" fill="#616c31" stroke="#1c1c1a" strokeWidth="1.5"/><path d="M20 25C25 16 29 10 31 6C25 10 22 16 20 25Z" fill="#758237" stroke="#1c1c1a" strokeWidth="1.5"/>
        </svg>
      </div>
    );
    if (tipo === 'vela') return (
      <div onClick={handleClick} className={wrapperClass} title="¡Haz clic para encender o apagar la vela!">
        <svg width="34" height="46" viewBox="0 0 32 44" fill="none" xmlns="http://www.w3.org/2000/svg" className="shrink-0 drop-shadow-sm">
          <path d="M8 20H24V42H8V20Z" fill="#f5f0e1" stroke="#1c1c1a" strokeWidth="1.5"/><path d="M15 16H17V20H15V16Z" fill="#1c1c1a"/><path className="vela-flama" d="M16 14C19 10 18 6 16 3C14 6 13 10 16 14Z" fill="#d96b14" stroke="#1c1c1a" strokeWidth="1.2"/>
        </svg>
      </div>
    );
    if (tipo === 'cafe') return (
      <div onClick={handleClick} className={wrapperClass} title="¡Haz clic para dar un sorbo a tu café!">
        <svg width="42" height="40" viewBox="0 0 40 38" fill="none" xmlns="http://www.w3.org/2000/svg" className="shrink-0 drop-shadow-sm">
          <path d="M8 14H28V32H8V14Z" fill="#FFFFFF" stroke="#1c1c1a" strokeWidth="1.5"/><path d="M28 17H33C35 17 35 25 33 25H28" stroke="#1c1c1a" strokeWidth="1.5"/><path d="M8 14H28V18H8V14Z" fill="#523021" stroke="#1c1c1a" strokeWidth="1.5"/><path className="humo-taza" d="M14 10C15 7 13 5 15 2" stroke="#a69982" strokeWidth="1.5" strokeLinecap="round"/><path className="humo-taza" style={{animationDelay: '1s'}} d="M22 11C23 8 21 6 23 3" stroke="#a69982" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      </div>
    );
    if (tipo === 'cactus') return (
      <div onClick={handleClick} className={wrapperClass} title="¡Haz clic en tu cactus!">
        <svg width="38" height="44" viewBox="0 0 36 42" fill="none" xmlns="http://www.w3.org/2000/svg" className="shrink-0 drop-shadow-sm">
          <path d="M10 32H26V40H10V32Z" fill="#9e6037" stroke="#1c1c1a" strokeWidth="1.5"/><path d="M15 12C15 8 21 8 21 12V32H15V12Z" fill="#4d5930" stroke="#1c1c1a" strokeWidth="1.5"/><path d="M10 18H15V22H10C8 22 8 18 10 18Z" fill="#4d5930" stroke="#1c1c1a" strokeWidth="1.5"/><path d="M21 16H26C28 16 28 20 26 20H21V16Z" fill="#4d5930" stroke="#1c1c1a" strokeWidth="1.5"/>
        </svg>
      </div>
    );
    if (tipo === 'auriculares') return (
      <div onClick={handleClick} className={wrapperClass} title="¡Tus auriculares cozy!">
        <svg width="40" height="40" viewBox="0 0 38 38" fill="none" xmlns="http://www.w3.org/2000/svg" className="shrink-0 drop-shadow-sm">
          <path d="M10 24V17C10 11 14 7 19 7C24 7 28 11 28 17V24" stroke="#1c1c1a" strokeWidth="1.5" strokeLinecap="round" fill="none"/>
          <rect x="7" y="22" width="6" height="10" rx="3" fill="#f7f3e8" stroke="#1c1c1a" strokeWidth="1.5"/>
          <rect x="25" y="22" width="6" height="10" rx="3" fill="#f7f3e8" stroke="#1c1c1a" strokeWidth="1.5"/>
        </svg>
      </div>
    );
    if (tipo === 'tocadiscos') return (
      <div onClick={handleClick} className={wrapperClass} title="¡Tu tocadiscos vintage!">
        <svg width="44" height="38" viewBox="0 0 42 36" fill="none" xmlns="http://www.w3.org/2000/svg" className="shrink-0 drop-shadow-sm">
          <rect x="3" y="10" width="36" height="22" rx="3" fill="#c9bea3" stroke="#1c1c1a" strokeWidth="1.5"/>
          <circle cx="15" cy="21" r="7" fill="#1c1c1a"/>
          <circle cx="15" cy="21" r="2.5" fill="#ffffee" stroke="#1c1c1a" strokeWidth="1.2"/>
          <path d="M26 15L31 22" stroke="#1c1c1a" strokeWidth="1.5" strokeLinecap="round"/>
          <circle cx="31" cy="22" r="1.5" fill="#ffffee" stroke="#1c1c1a" strokeWidth="1"/>
        </svg>
      </div>
    );
    if (tipo === 'camara') return (
      <div onClick={handleClick} className={wrapperClass} title="¡Tu cámara analógica!">
        <svg width="42" height="36" viewBox="0 0 40 34" fill="none" xmlns="http://www.w3.org/2000/svg" className="shrink-0 drop-shadow-sm">
          <rect x="4" y="10" width="32" height="20" rx="3" fill="#595750" stroke="#1c1c1a" strokeWidth="1.5"/>
          <path d="M12 10V7H28V10" fill="#f7f3e8" stroke="#1c1c1a" strokeWidth="1.5"/>
          <circle cx="20" cy="20" r="6" fill="#f7f3e8" stroke="#1c1c1a" strokeWidth="1.5"/>
          <circle cx="20" cy="20" r="3" fill="#3d4220"/>
          <circle cx="10" cy="15" r="1.5" fill="#ffffee" stroke="#1c1c1a" strokeWidth="1"/>
        </svg>
      </div>
    );
    if (tipo === 'lampara') return (
      <div onClick={handleClick} className={wrapperClass} title="¡Tu lámpara de lectura!">
        <svg width="36" height="46" viewBox="0 0 34 44" fill="none" xmlns="http://www.w3.org/2000/svg" className="shrink-0 drop-shadow-sm">
          <path d="M12 40H22" stroke="#1c1c1a" strokeWidth="2" strokeLinecap="round"/>
          <path d="M17 40V22L9 12" stroke="#595750" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M6 12H16L19 6H9L6 12Z" fill="#3d4220" stroke="#1c1c1a" strokeWidth="1.5"/>
        </svg>
      </div>
    );
    return null;
  }

  function AvatarUsuaria({ foto, nombre, sizeClass = "w-9 h-9", textClass = "text-lg", editable = false, onFotoChange = () => {} }) {
    const [errorImg, setErrorImg] = useState(false);
    const fileInputRef = useRef(null);

    const handleFileChange = (e) => {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onloadend = () => {
          setErrorImg(false);
          onFotoChange(reader.result);
        };
        reader.readAsDataURL(file);
      }
    };

    const renderContent = () => {
      if (foto && foto.trim() !== '' && !errorImg) {
        return <img src={foto} alt={nombre || 'Lector(a)'} onError={() => setErrorImg(true)} className={`${sizeClass} rounded-full object-cover border border-[#e6e4dc] shrink-0`} />;
      }
      return <div className={`${sizeClass} rounded-full bg-[#faf9f5] border border-[#e6e4dc] flex items-center justify-center font-babydoll ${textClass} text-[#3d4220] shrink-0 font-bold`}>{(nombre || 'L').charAt(0).toUpperCase()}</div>;
    };

    if (editable) {
      return (
        <div className="relative group cursor-pointer" onClick={() => fileInputRef.current && fileInputRef.current.click()} title="Cambiar foto de perfil desde tu galería">
          {renderContent()}
          <div className="absolute inset-0 rounded-full bg-black/30 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
            <i className="fa-solid fa-camera text-white text-xs"></i>
          </div>
          <input type="file" ref={fileInputRef} accept="image/*" onChange={handleFileChange} className="hidden" />
        </div>
      );
    }
    return renderContent();
  }

  function CalendarioInteractivo({ eventos }) {
    const [fechaActual, setFechaActual] = useState(new Date());
    const [diaSeleccionado, setDiaSeleccionado] = useState(null);
    const diasSemana = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
    const nombresMeses = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

    const anio = fechaActual.getFullYear();
    const mes = fechaActual.getMonth();
    const primerDiaMes = new Date(anio, mes, 1);
    const ultimoDiaMes = new Date(anio, mes + 1, 0);

    let primerDiaSemanaIndice = primerDiaMes.getDay() - 1;
    if (primerDiaSemanaIndice === -1) primerDiaSemanaIndice = 6;
    const totalDiasMes = ultimoDiaMes.getDate();
    const hoy = new Date();
    const esMesActual = hoy.getFullYear() === anio && hoy.getMonth() === mes;

    const parsearFechaEvento = useCallback((strFecha) => {
      if (!strFecha) return null;
      const s = strFecha.toString().trim().toLowerCase();
      if (s.includes('-') || s.includes('/')) {
        const partes = s.split(/[/-]/);
        if (partes.length >= 2) {
          if (partes[0].length === 4) {
            return { dia: parseInt(partes[2], 10), mes: parseInt(partes[1], 10) - 1, anio: parseInt(partes[0], 10) };
          } else {
            return { dia: parseInt(partes[0], 10), mes: parseInt(partes[1], 10) - 1, anio: partes[2] ? parseInt(partes[2], 10) : anio };
          }
        }
      }
      const matchDia = s.match(/^(\d{1,2})/);
      if (matchDia) {
        const diaNum = parseInt(matchDia[1], 10);
        const mapaMeses = {
          ene: 0, enero: 0, feb: 1, febrero: 1, mar: 2, marzo: 2, abr: 3, abril: 3,
          may: 4, mayo: 4, jun: 5, junio: 5, jul: 6, julio: 6, ago: 7, agosto: 7,
          sep: 8, sept: 8, septiembre: 8, oct: 9, octubre: 9, nov: 10, noviembre: 10, dic: 11, diciembre: 11
        };
        for (const [clave, mesIndex] of Object.entries(mapaMeses)) {
          if (s.includes(clave)) {
            const matchAnio = s.match(/\b(20\d{2})\b/);
            return { dia: diaNum, mes: mesIndex, anio: matchAnio ? parseInt(matchAnio[1], 10) : anio };
          }
        }
      }
      return null;
    }, [anio]);

    const eventosDelMes = useMemo(() => {
      const mapa = {};
      (eventos || []).forEach(ev => {
        const est = (ev.estado || '').toLowerCase();
        if (est === 'pendiente' || est === 'por definir') return;
        const parsed = parsearFechaEvento(ev.fecha || ev.dia || ev.date || ev.fecha_evento);
        if (parsed && parsed.mes === mes && parsed.anio === anio) {
          if (!mapa[parsed.dia]) mapa[parsed.dia] = [];
          mapa[parsed.dia].push(ev);
        }
      });
      return mapa;
    }, [eventos, mes, anio, parsearFechaEvento]);

    const mesAnterior = () => { setFechaActual(new Date(anio, mes - 1, 1)); setDiaSeleccionado(null); };
    const mesSiguiente = () => { setFechaActual(new Date(anio, mes + 1, 1)); setDiaSeleccionado(null); };

    const celdas = [];
    for (let i = 0; i < primerDiaSemanaIndice; i++) {
      celdas.push(<div key={`empty-${i}`} className="h-9"></div>);
    }

    for (let dia = 1; dia <= totalDiasMes; dia++) {
      const esHoy = esMesActual && hoy.getDate() === dia;
      const evs = eventosDelMes[dia] || [];
      const tieneEventos = evs.length > 0;
      
      celdas.push(
        <div 
          key={dia} 
          onClick={() => {
            if (tieneEventos) {
              setDiaSeleccionado({ dia, eventos: evs });
            } else {
              setDiaSeleccionado(null);
            }
          }}
          className={`h-9 flex flex-col items-center justify-center rounded-xl relative transition-all text-xs font-sans cursor-pointer ${esHoy ? 'bg-[#3d4220] text-white font-bold shadow-sm' : 'hover:bg-[#faf9f5] text-[#1c1c1a]'} ${tieneEventos && !esHoy ? 'border border-[#3d4220]/40 font-bold bg-[#ffffee]' : ''}`}
        >
          <span>{dia}</span>
          {tieneEventos && <span className={`w-1.5 h-1.5 rounded-full mt-0.5 ${esHoy ? 'bg-amber-300' : 'bg-[#3d4220]'}`}></span>}
        </div>
      );
    }

    return (
      <div className="space-y-3">
        <div className="flex justify-between items-center bg-[#ffffee] p-2.5 rounded-xl border border-[#e6e4dc]">
          <button onClick={mesAnterior} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-white text-[#1c1c1a]"><i className="fa-solid fa-chevron-left text-xs"></i></button>
          <h4 className="font-babydoll text-base font-bold text-[#1c1c1a]">{nombresMeses[mes]} {anio}</h4>
          <button onClick={mesSiguiente} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-white text-[#1c1c1a]"><i className="fa-solid fa-chevron-right text-xs"></i></button>
        </div>
        <div className="grid grid-cols-7 gap-1 text-center font-sans text-[10px] uppercase font-semibold text-[#595750] pb-1 border-b border-[#e6e4dc]">
          {diasSemana.map((d, i) => <div key={i}>{d}</div>)}
        </div>
        <div className="grid grid-cols-7 gap-1 text-center">{celdas}</div>

        {diaSeleccionado && (
          <div className="bg-[#ffffee] border border-[#e6e4dc] p-3.5 rounded-xl space-y-2.5 mt-2 fade-in text-left shadow-sm">
            <div className="flex justify-between items-center border-b border-[#e6e4dc] pb-1.5">
              <span className="font-babydoll font-bold text-sm text-[#1c1c1a]">
                Eventos del {diaSeleccionado.dia} de {nombresMeses[mes]}
              </span>
              <button onClick={() => setDiaSeleccionado(null)} className="text-xs text-[#595750] hover:text-black p-1">
                <i className="fa-solid fa-xmark"></i>
              </button>
            </div>
            <div className="space-y-2 max-h-36 overflow-y-auto pr-1">
              {diaSeleccionado.eventos.map((ev, idx) => (
                <div key={idx} className="bg-white p-2.5 rounded-lg border border-[#e6e4dc] text-xs space-y-1">
                  <p className="font-bold text-[#1c1c1a] font-babydoll text-sm">{ev.evento || ev.titulo || 'Evento del club'}</p>
                  <div className="flex items-center gap-1.5 text-[10px] text-[#595750] font-sans">
                    <i className="fa-regular fa-clock text-[#3d4220]"></i>
                    <span>{ev.hora && ev.hora.trim() !== '' ? ev.hora : 'Durante todo el día'}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  function EdificioClub({ usuarias, libroActual, onAddWantToRead, onAbrirPrivado, sesionEmail, chatBloqueado }) {
    const [usuariaActivaEmail, setUsuariaActivaEmail] = useState('');
    const listaUsuarias = usuarias.length > 0 ? usuarias : [];
    const usuariaActiva = listaUsuarias.find(u => (u.email || '').toLowerCase().trim() === usuariaActivaEmail) || listaUsuarias[0] || {};
    const usuariaActivaKey = (usuariaActiva.email || '').toLowerCase().trim();
    const tieneProgresoClub = Number(usuariaActiva.pagina || 0) > 0;
    const misLibrosPersonales = usuariaActiva.misLecturasPersonales || [];
    const esOtraSocia = usuariaActiva.email && sesionEmail && usuariaActiva.email.toLowerCase().trim() !== sesionEmail.toLowerCase().trim();

    return (
      <div className="flex flex-col items-center w-full max-w-[480px] mx-auto py-2 relative">
        <h2 className="text-[52px] font-babydoll text-center mb-0 text-[#1c1c1a] leading-none">gilda</h2>
        <p className="text-[13px] text-[#595750] text-center mb-5 leading-relaxed font-sans italic">gilda!!!!, cartas y creatividad</p>
        
        <div className="grid grid-cols-3 gap-x-6 gap-y-8 w-full max-w-[240px] mx-auto mb-10">
          {listaUsuarias.map((usuaria, indice) => {
            const estaLeyendo = usuaria.estaLeyendo;
            const usuariaKey = (usuaria.email || `usuaria-${indice}`).toLowerCase().trim();
            const seleccionada = usuariaKey === usuariaActivaKey;
            const nombreMostrar = (usuaria.nombre || 'Lector(a)').split(' ')[0].toLowerCase();
            return (
              <div key={usuaria.email || indice} className="relative flex flex-col items-center">
                <button
                  type="button"
                  onClick={() => setUsuariaActivaEmail(usuaria.email ? usuariaKey : '')}
                  aria-pressed={seleccionada}
                  aria-label={`Abrir la ventana de ${usuaria.nombre || usuaria.email || 'lectora'}`}
                  className={`w-[34px] h-[46px] rounded-[3px] cursor-pointer transition-all duration-200 hover:scale-105 relative border ${estaLeyendo ? 'bg-[#ffffee] border-[#d4cfbc] shadow-[0_4px_12px_rgba(210,200,160,0.3)]' : 'bg-[#dedbd0] border-[#c9c6b3]'} ${seleccionada ? 'outline-[1.5px] outline-[#3d4220] outline-offset-[3px]' : ''}`}
                ></button>
                <div className="flex items-center justify-center mt-1.5">
                  <span className="text-[12px] text-[#595750] font-bold tracking-tight truncate max-w-[65px] text-center font-sans">{nombreMostrar}</span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="editorial-card w-full p-5 flex flex-col gap-4 fade-in">
          <div className="flex flex-col gap-2 w-full border-b border-[#e6e4dc] pb-2.5">
            <div className="flex justify-between items-center w-full">
              <div className="flex items-center gap-2 min-w-0">
                <AvatarUsuaria foto={usuariaActiva.foto_perfil} nombre={usuariaActiva.nombre} sizeClass="w-7 h-7" textClass="text-xs" />
                <span className="font-babydoll text-lg sm:text-xl font-bold text-[#1c1c1a] leading-tight">
                  la habitación de {
                    (
                      (usuariaActiva && usuariaActiva.nombre && usuariaActiva.nombre.trim() !== '') 
                        ? usuariaActiva.nombre 
                        : (usuariaActiva && usuariaActiva.email ? usuariaActiva.email.split('@')[0] : 'lectora')
                    ).toLowerCase()
                  }
                </span>
              </div>
              <span className="text-[10px] text-[#595750] font-bold font-sans shrink-0">@gilda.mailclub</span>
            </div>

            {esOtraSocia && (
              <div className="flex justify-end pt-0.5">
                <button 
                  onClick={() => onAbrirPrivado(usuariaActiva)} 
                  className="bg-[#3d4220] text-white px-3 py-1 rounded-xl text-[10px] font-bold font-sans flex items-center gap-1.5 hover:bg-black transition-colors shadow-xs"
                  title={chatBloqueado ? 'Mejora tu modalidad para usar el chat' : 'Enviar privado'}
                >
                  <i className={`fa-solid ${chatBloqueado ? 'fa-lock' : 'fa-envelope'} text-[9px]`}></i> {chatBloqueado ? 'Mejorar modalidad' : 'Enviar privado'}
                </button>
              </div>
            )}
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3 bg-[#ffffee] p-3 rounded-xl border border-[#e6e4dc]">
              <div className="flex items-center gap-3 overflow-hidden">
                <PortadaLibroEstable titulo={libroActual.titulo} autora={libroActual.autora} portada={libroActual.portada} size="thumb" />
                <div className="text-xs text-[#1c1c1a] overflow-hidden">
                  <p className="font-bold truncate font-babydoll text-sm">{libroActual.titulo}</p>
                  <p className="text-[11px] text-[#595750] font-sans">pág. <b>{tieneProgresoClub ? usuariaActiva.pagina : 0}</b></p>
                </div>
              </div>
              <button onClick={() => onAddWantToRead(libroActual.titulo, libroActual.autora, libroActual.portada)} className="shrink-0 bg-[#FFFFFF] text-[#1c1c1a] border border-[#e6e4dc] hover:bg-[#3d4220] hover:text-white px-3 py-1.5 rounded-full text-[10px] font-semibold transition-colors flex items-center gap-1 font-sans">
                <i className="fa-solid fa-bookmark text-[9px]"></i> + Guardar
              </button>
            </div>
            {misLibrosPersonales.map((item, idx) => (
              <div key={idx} className="flex items-center justify-between gap-3 bg-[#ffffee] p-3 rounded-xl border border-[#e6e4dc]">
                <div className="flex items-center gap-3 overflow-hidden">
                  <PortadaLibroEstable titulo={item.libro} autora={item.autora || ''} portada={item.portada || ''} size="thumb" />
                  <div className="text-xs text-[#1c1c1a] overflow-hidden">
                    <p className="font-bold truncate font-babydoll text-sm">{item.libro}</p>
                    <p className="text-[11px] text-[#595750] font-sans">pág. <b>{item.pagina || item.paginas || 0}</b></p>
                  </div>
                </div>
                <button onClick={() => onAddWantToRead(item.libro, item.autora || '', item.portada || '')} className="shrink-0 bg-[#FFFFFF] text-[#1c1c1a] border border-[#e6e4dc] hover:bg-[#3d4220] hover:text-white px-3 py-1.5 rounded-full text-[10px] font-semibold transition-colors flex items-center gap-1 font-sans">
                  <i className="fa-solid fa-bookmark text-[9px]"></i> + Guardar
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  function MapaGilda({ usuarias }) {
    const mapRef = useRef(null);
    const leafletRef = useRef(null);
    const mapContainerRef = useRef(null);
    const markersGroupRef = useRef(null);
    const marcadoresKeyRef = useRef(null);
    const usuariasGeocodificadasRef = useRef([]);
    const [regionSeleccionada, setRegionSeleccionada] = useState(null);
    const [paisExpandido, setPaisExpandido] = useState(null);
    const idContadorPais = useId();
    const [mapReady, setMapReady] = useState(false);
    const [coordenadasInternacionales, setCoordenadasInternacionales] = useState({});

    const GEO_INTERNA = useMemo(() => ({
      'madrid': { coords: [40.4168, -3.7038], ca: 'Comunidad de Madrid' },
      'barcelona': { coords: [41.3851, 2.1734], ca: 'Cataluña' },
      'bilbao': { coords: [43.2630, -2.9350], ca: 'País Vasco' },
      'sevilla': { coords: [37.3891, -5.9845], ca: 'Andalucía' },
      'valencia': { coords: [39.4699, -0.3763], ca: 'Comunidad Valenciana' },
      'zaragoza': { coords: [41.6488, -0.8891], ca: 'Aragón' },
      'málaga': { coords: [36.7213, -4.4214], ca: 'Andalucía' },
      'murcia': { coords: [37.9922, -1.1307], ca: 'Región de Murcia' },
      'palma': { coords: [39.5696, 2.6502], ca: 'Islas Baleares' },
      'las palmas': { coords: [28.1235, -15.4363], ca: 'Canarias' },
      'alicante': { coords: [38.3452, -0.4810], ca: 'Comunidad Valenciana' },
      'córdoba': { coords: [37.8882, -4.7794], ca: 'Andalucía' },
      'valladolid': { coords: [41.6523, -4.7245], ca: 'Castilla y León' },
      'vigo': { coords: [42.2406, -8.7207], ca: 'Galicia' },
      'gijón': { coords: [43.5357, -5.6615], ca: 'Asturias' },
      'a coruña': { coords: [43.3623, -8.4115], ca: 'Galicia' },
      'granada': { coords: [37.1773, -3.5986], ca: 'Andalucía' },
      'vitoria': { coords: [42.8467, -2.6716], ca: 'País Vasco' },
      'santa cruz de tenerife': { coords: [28.4636, -16.2518], ca: 'Canarias' },
      'pamplona': { coords: [42.8125, -1.6458], ca: 'Navarra' },
      'almería': { coords: [36.8340, -2.4637], ca: 'Andalucía' },
      'san sebastian': { coords: [43.3183, -1.9812], ca: 'País Vasco' },
      'burgos': { coords: [42.3440, -3.6969], ca: 'Castilla y León' },
      'albacete': { coords: [38.9942, -1.8585], ca: 'Castilla-La Mancha' },
      'santander': { coords: [43.4623, -3.8099], ca: 'Cantabria' },
      'girona': { coords: [41.9794, 2.8214], ca: 'Cataluña' },
      'tarragona': { coords: [41.1189, 1.2445], ca: 'Cataluña' },
      'lleida': { coords: [41.6176, 0.6200], ca: 'Cataluña' },
      'oviedo': { coords: [43.3619, -5.8494], ca: 'Asturias' },
      'toledo': { coords: [39.8628, -4.0273], ca: 'Castilla-La Mancha' },
      'cadiz': { coords: [36.5271, -6.2886], ca: 'Andalucía' },
      'huelva': { coords: [37.2664, -6.9400], ca: 'Andalucía' },
      'jaen': { coords: [37.7796, -3.7849], ca: 'Andalucía' },
      'huesca': { coords: [42.1401, -0.4089], ca: 'Aragón' },
      'teruel': { coords: [40.3456, -1.1065], ca: 'Aragón' },
      'leon': { coords: [42.5987, -5.5671], ca: 'Castilla y León' },
      'salamanca': { coords: [40.9701, -5.6635], ca: 'Castilla y León' }
    }), []);

    const buscarUbicacion = useCallback((texto, pais = '') => {
      if (!texto) return null;
      const partes = texto.split(',').map(parte => parte.trim()).filter(Boolean);
      const ciudad = partes[0] || texto.trim();
      const paisIndicado = pais || partes.slice(1).join(', ');
      const paisNormalizado = normalizarUbicacion(paisIndicado);
      const esEspana = !paisNormalizado || ['espana', 'spain', 'es', 'españa'].includes(paisNormalizado);
      if (!esEspana) return null;

      const limpio = ciudad.toLowerCase().trim();
      if (GEO_INTERNA[limpio]) return GEO_INTERNA[limpio];
      for (const [clave, val] of Object.entries(GEO_INTERNA)) {
        if (limpio.includes(clave) || clave.includes(limpio)) return val;
      }
      return null;
    }, [GEO_INTERNA]);

    const comunidadesEspanolas = useMemo(() => new Map([
      ['andalucia', 'Andalucía'],
      ['aragon', 'Aragón'],
      ['asturias', 'Asturias'],
      ['principado de asturias', 'Asturias'],
      ['islas baleares', 'Islas Baleares'],
      ['illes balears', 'Islas Baleares'],
      ['canarias', 'Canarias'],
      ['cantabria', 'Cantabria'],
      ['castilla-la mancha', 'Castilla-La Mancha'],
      ['castilla la mancha', 'Castilla-La Mancha'],
      ['castilla y leon', 'Castilla y León'],
      ['cataluna', 'Cataluña'],
      ['comunidad valenciana', 'Comunidad Valenciana'],
      ['comunitat valenciana', 'Comunidad Valenciana'],
      ['extremadura', 'Extremadura'],
      ['galicia', 'Galicia'],
      ['comunidad de madrid', 'Comunidad de Madrid'],
      ['madrid', 'Comunidad de Madrid'],
      ['region de murcia', 'Región de Murcia'],
      ['región de murcia', 'Región de Murcia'],
      ['murcia', 'Región de Murcia'],
      ['navarra', 'Navarra'],
      ['comunidad foral de navarra', 'Navarra'],
      ['pais vasco', 'País Vasco'],
      ['euskadi', 'País Vasco'],
      ['la rioja', 'La Rioja'],
      ['ceuta', 'Ceuta'],
      ['melilla', 'Melilla']
    ]), []);

    const usuariasGeocodificadas = useMemo(() => {
      const mapaCoordenadasSocio = {};
      return usuarias.map(u => {
        const ciudadOriginal = String(u.ciudad || u.city || u.localidad || u.provincia_region || u.province_region || '').trim();
        const partesCiudad = ciudadOriginal.split(',').map(parte => parte.trim()).filter(Boolean);
        const paisOriginal = String(u.pais || u.país || u.country || u.country_name || u.country_code || partesCiudad.slice(1).join(', ') || '').trim();
        const ciudad = partesCiudad[0] || ciudadOriginal;
        const consultaGeo = [ciudad, paisOriginal].filter(Boolean).join(', ') || ciudadOriginal;
        const infoLoc = buscarUbicacion(ciudadOriginal, paisOriginal);
        const coordenadasExternas = coordenadasInternacionales[normalizarUbicacion(consultaGeo)];
        const regionOriginal = String(u.comunidad_autonoma || u.comunidad || u.autonomous_community || u.region || u.state || u.provincia_region || u.province_region || u.province || '').trim();
        const regionNormalizada = normalizarUbicacion(regionOriginal);
        const regionGeocodificada = coordenadasExternas?.region || '';
        const regionExplicita = comunidadesEspanolas.get(regionNormalizada)
          || [...comunidadesEspanolas.entries()].find(([nombre]) => regionNormalizada.includes(nombre))?.[1]
          || comunidadesEspanolas.get(normalizarUbicacion(regionGeocodificada))
          || [...comunidadesEspanolas.entries()].find(([nombre]) => normalizarUbicacion(regionGeocodificada).includes(nombre))?.[1]
          || '';
        const paisAgrupado = formatearPais(paisOriginal || (infoLoc || regionExplicita ? 'España' : coordenadasExternas?.country)) || 'No especificado';
        const regionAgrupada = paisAgrupado === 'España'
          ? regionExplicita || infoLoc?.ca || 'No especificada'
          : regionOriginal || regionGeocodificada || 'No especificada';
        const latitudRaw = u.latitud ?? u.latitude ?? u.lat;
        const longitudRaw = u.longitud ?? u.longitude ?? u.lon ?? u.lng;
        const latitud = Number(latitudRaw);
        const longitud = Number(longitudRaw);
        const tieneCoordenadas = latitudRaw !== undefined && latitudRaw !== ''
          && longitudRaw !== undefined && longitudRaw !== ''
          && Number.isFinite(latitud) && Number.isFinite(longitud)
          && Math.abs(latitud) <= 90 && Math.abs(longitud) <= 180;
        const baseCoords = tieneCoordenadas
          ? [latitud, longitud]
          : infoLoc?.coords || coordenadasExternas?.coords;
        if (!baseCoords) {
          return { ...u, coords: null, paisAgrupado, regionAgrupada, consultaGeo };
        }

        const coordKey = `${baseCoords[0].toFixed(4)},${baseCoords[1].toFixed(4)}`;
        let coordsFinales = [...baseCoords];

        if (!mapaCoordenadasSocio[coordKey]) {
          mapaCoordenadasSocio[coordKey] = 1;
        } else {
          const count = mapaCoordenadasSocio[coordKey];
          mapaCoordenadasSocio[coordKey]++;
          
          const angle = count * 2.39996; 
          const radius = 0.015 * Math.sqrt(count);
          coordsFinales = [
            baseCoords[0] + radius * Math.cos(angle),
            baseCoords[1] + radius * Math.sin(angle)
          ];
        }
        return { ...u, coords: coordsFinales, paisAgrupado, regionAgrupada, consultaGeo };
      });
    }, [usuarias, coordenadasInternacionales, buscarUbicacion, comunidadesEspanolas]);

    const consultasGeoKey = useMemo(() => (
      JSON.stringify([...new Set(usuariasGeocodificadas.filter(u => !u.coords && u.consultaGeo).map(u => u.consultaGeo))].sort())
    ), [usuariasGeocodificadas]);

    useEffect(() => {
      const consultas = JSON.parse(consultasGeoKey);
      consultas.forEach(consulta => {
        geocodificarUbicacion(consulta).then(coordenadas => {
          if (!coordenadas) return;
          const key = normalizarUbicacion(consulta);
          setCoordenadasInternacionales(prev => prev[key] ? prev : { ...prev, [key]: coordenadas });
        });
      });
    }, [consultasGeoKey]);

    const conteoPorPais = useMemo(() => {
      const conteo = new Map();
      usuariasGeocodificadas.forEach(u => {
        const pais = u.paisAgrupado || 'No especificado';
        const region = u.regionAgrupada || 'No especificada';
        if (!conteo.has(pais)) conteo.set(pais, { total: 0, regiones: new Map() });
        const grupo = conteo.get(pais);
        grupo.total += 1;
        grupo.regiones.set(region, (grupo.regiones.get(region) || 0) + 1);
      });
      return [...conteo.entries()]
        .map(([pais, grupo]) => ({
          pais,
          total: grupo.total,
          regiones: [...grupo.regiones.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es'))
        }))
        .sort((a, b) => b.total - a.total || a.pais.localeCompare(b.pais, 'es'));
    }, [usuariasGeocodificadas]);

    const mapaDatosKey = useMemo(() => (
      JSON.stringify(usuariasGeocodificadas.map(u => ({
        email: (u.email || '').trim().toLowerCase(),
        nombre: u.nombre || '',
        pais: u.paisAgrupado || '',
        region: u.regionAgrupada || '',
        coords: u.coords || []
      })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
    ), [usuariasGeocodificadas]);
    usuariasGeocodificadasRef.current = usuariasGeocodificadas;

    useEffect(() => {
      const container = mapContainerRef.current;
      if (!container) return;

      let retryTimer;
      let resizeTimer;
      let activo = true;
      let inicializando = false;
      const inicializarMapa = async () => {
        if (!activo || !container.isConnected) return;
        const estilos = window.getComputedStyle(container);
        const tieneDimensiones = estilos.display !== 'none'
          && estilos.visibility !== 'hidden'
          && container.offsetWidth > 0
          && container.offsetHeight > 0;
        if (!tieneDimensiones) {
          retryTimer = setTimeout(inicializarMapa, 150);
          return;
        }

        if (mapRef.current) {
          mapRef.current.invalidateSize();
          return;
        }
        if (inicializando) return;
        inicializando = true;

        try {
          const moduloLeaflet = await import('leaflet');
          if (!activo || !container.isConnected) return;
          const Leaflet = moduloLeaflet.default || moduloLeaflet;
          leafletRef.current = Leaflet;

        if (!mapRef.current) {
          const map = Leaflet.map(container, {
            zoomControl: false,
            attributionControl: false,
            zoomAnimation: false,
            fadeAnimation: false,
            markerZoomAnimation: false
          }).setView([40.4167, -3.7037], 5);
          Leaflet.control.zoom({ position: 'topright' }).addTo(map);
          Leaflet.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', { maxZoom: 16 }).addTo(map);
          markersGroupRef.current = Leaflet.layerGroup().addTo(map);
          mapRef.current = map;
          setMapReady(true);
        }

        resizeTimer = setTimeout(() => {
          if (activo && mapRef.current && container.offsetWidth > 0 && container.offsetHeight > 0) {
            mapRef.current.invalidateSize();
          }
        }, 100);
        } catch (error) {
          console.error('No se pudo cargar Leaflet:', error);
        } finally {
          inicializando = false;
        }
      };

      const observer = typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(inicializarMapa)
        : null;
      observer?.observe(container);
      inicializarMapa();

      return () => {
        activo = false;
        clearTimeout(retryTimer);
        clearTimeout(resizeTimer);
        observer?.disconnect();
        if (mapRef.current) {
          mapRef.current.stop();
          mapRef.current.remove();
          mapRef.current = null;
        }
        markersGroupRef.current = null;
        marcadoresKeyRef.current = null;
      };
    }, []);

    useEffect(() => {
      const map = mapRef.current;
      const Leaflet = leafletRef.current;
      const markersGroup = markersGroupRef.current;
      const container = mapContainerRef.current;
      if (!Leaflet || !map || !map._loaded || !markersGroup || !container || !container.isConnected) return;

      const estilos = window.getComputedStyle(container);
      if (estilos.display === 'none' || estilos.visibility === 'hidden' || container.offsetWidth === 0 || container.offsetHeight === 0) return;

      if (marcadoresKeyRef.current === mapaDatosKey) return;

      map.invalidateSize();
      markersGroup.clearLayers();
      const boundsArray = [];

      usuariasGeocodificadasRef.current.forEach(item => {
        const coor = item.coords;
        if (!Array.isArray(coor) || coor.length !== 2 || !coor.every(Number.isFinite)) return;
        boundsArray.push(coor);
        const piruletaHtml = `
          <div style="position: relative; width: 18px; height: 26px; display: flex; items-align: center; justify-content: center; cursor: pointer;" title="${item.nombre}">
            <svg viewBox="0 0 16 24" width="18" height="26" style="filter: drop-shadow(0px 2px 3px rgba(0,0,0,0.3));">
              <line x1="8" y1="12" x2="8" y2="23" stroke="#1c1c1a" stroke-width="2" stroke-linecap="round"/>
              <circle cx="8" cy="7" r="6" fill="#3d4220" stroke="#1c1c1a" stroke-width="1.5"/>
            </svg>
            <span style="position: absolute; top: 1.5px; width: 100%; text-align: center; color: #FFFFFF; font-weight: bold; font-size: 8px; font-family: sans-serif;">1</span>
          </div>
        `;
        if (!mapRef.current || !mapRef.current._loaded || !markersGroupRef.current) return;
        const customIcon = Leaflet.divIcon({ html: piruletaHtml, className: 'custom-piruleta-mini', iconSize: [18, 26], iconAnchor: [9, 25], popupAnchor: [0, -26] });
        const marker = Leaflet.marker(coor, { icon: customIcon });
        
        marker.on('click', () => {
          const usuariasActuales = usuariasGeocodificadasRef.current;
          setRegionSeleccionada({
            region: [item.regionAgrupada, item.paisAgrupado].filter(Boolean).join(', '),
            usuarias: usuariasActuales.filter(u => u.regionAgrupada === item.regionAgrupada && u.paisAgrupado === item.paisAgrupado)
          });
        });
        
        if (mapRef.current && mapRef.current._loaded && markersGroupRef.current) {
          markersGroupRef.current.addLayer(marker);
        }
      });

      if (boundsArray.length > 0 && mapRef.current && mapRef.current._loaded && markersGroupRef.current) {
        mapRef.current.fitBounds(boundsArray, { padding: [30, 30], maxZoom: 6 });
      }
      marcadoresKeyRef.current = mapaDatosKey;
    }, [mapaDatosKey, mapReady]);

    const limpiarRegion = () => {
      setRegionSeleccionada(null);
    };

    return (
      <div className="space-y-4 relative">
        <div className="relative">
          <div ref={mapContainerRef} style={{ height: '280px', width: '100%', borderRadius: '16px', border: '1px solid var(--border-editorial)', zIndex: 1 }} className="transition-opacity duration-300"></div>
          {regionSeleccionada && (
            <div className="absolute inset-0 z-[1000] bg-[#FFFFFF]/95 backdrop-blur-md p-4 flex flex-col rounded-xl fade-in text-[#1c1c1a] shadow-2xl max-h-[280px] overflow-hidden">
              <div className="flex justify-between items-center border-b border-[#e6e4dc] pb-2 mb-2 shrink-0">
                <h3 className="font-babydoll text-[#1c1c1a] font-bold text-lg leading-none">{regionSeleccionada.region} ({regionSeleccionada.usuarias.length})</h3>
                <button onClick={limpiarRegion} className="text-[11px] font-bold text-[#595750] bg-white border border-[#e6e4dc] px-2.5 py-1 rounded-lg hover:bg-gray-100 transition-colors">
                  cerrar
                </button>
              </div>
              <div className="overflow-y-auto flex-grow space-y-2 pr-1">
                {regionSeleccionada.usuarias.map((u, i) => (
                  <div key={i} className="flex justify-between items-center text-xs p-2.5 bg-white rounded-xl border border-[#e6e4dc] gap-2 shadow-xs">
                    <span className="font-bold font-babydoll text-sm text-[#1c1c1a]">{u.nombre}</span>
                    <span className="text-[#595750] font-sans text-[11px] italic">{u.ciudad || u.provincia_region || 'Sin localidad'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="editorial-card p-4 space-y-2.5">
          <h4 className="font-babydoll text-base font-bold text-[#1c1c1a]">Usuarias por país</h4>
          <div className="space-y-1 max-h-56 overflow-y-auto pr-1">
            {conteoPorPais.map(({ pais, total, regiones }, idx) => {
              const expandido = paisExpandido === pais;
              const regionesId = `${idContadorPais}-regiones-${idx}`;
              return (
                <div key={pais} className="rounded-lg border border-[#e6e4dc] overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setPaisExpandido(expandido ? null : pais)}
                    aria-expanded={expandido}
                    aria-controls={regionesId}
                    className="w-full flex items-center justify-between gap-3 bg-[#ffffee] px-3 py-2.5 text-xs text-left hover:bg-[#faf9f5] transition-colors"
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <i className={`fa-solid ${expandido ? 'fa-chevron-down' : 'fa-chevron-right'} text-[9px] text-[#595750]`}></i>
                      <span className="font-bold font-babydoll truncate">{pais}</span>
                    </span>
                    <span className="bg-[#3d4220] text-white px-2 py-0.5 rounded-full text-[10px] font-bold shrink-0">{total}</span>
                  </button>
                  {expandido && (
                    <div id={regionesId} className="px-3 py-2 space-y-1.5 border-t border-[#e6e4dc] bg-white">
                      <p className="text-[9px] uppercase font-bold text-[#595750]">
                        {pais === 'España' ? 'Comunidades autónomas' : 'Regiones / provincias'}
                      </p>
                      {regiones.map(([region, cantidad]) => (
                        <div key={region} className="flex justify-between items-center gap-3 text-[11px] pl-2">
                          <span className="text-[#1c1c1a] truncate">{region}</span>
                          <span className="text-[#595750] font-bold shrink-0">{cantidad}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  const [sesion, setSesion] = useState(() => safeGetJSON('gilda_sesion', null));
  const [vistaAcceso, setVistaAcceso] = useState('menu');
  const [inputEmail, setInputEmail] = useState('');
  const [inputPassword, setInputPassword] = useState('');
  const [errorLogin, setErrorLogin] = useState('');
  const [tabActiva, setTabActiva] = useState('login');
  const [mostrarPass, setMostrarPass] = useState(false);
  const [modalidadSeleccionada, setModalidadSeleccionada] = useState(null);
  const [enviandoRegistro, setEnviandoRegistro] = useState(false);
  const [mostrarModalShare, setMostrarModalShare] = useState(false);

  const modalidades = [
    { id: 'cotilla', nombre: 'gilda cotilla', precio: 'Gratis', esGratis: true, enlaceStripe: '', descripcion: 'Lee los comentarios de las demás y forma parte de lo más básico de la comunidad de forma gratuita.' },
    { id: 'satelite', nombre: 'gilda satélite', precio: '1 €/mes', esGratis: false, enlaceStripe: 'https://buy.stripe.com/cNi4gtfqV8cxeju0WV6Ri01', descripcion: 'Forma parte de la comunidad y lee a tu ritmo mientras vas comentando y leyendo a las demás.' },
    { id: 'cafe', nombre: 'gilda de café', precio: '5 €/mes', esGratis: false, enlaceStripe: 'https://buy.stripe.com/3cI5kx0w1gJ3fny4976Ri02', descripcion: 'Forma parte de la comunidad al completo, chat, cafecitos virtuales y sorteos.' },
    { id: 'nube', nombre: 'gilda de nube', precio: '5 €/mes', esGratis: false, enlaceStripe: 'https://buy.stripe.com/cNi5kx92xcsNb7i3536Ri03', descripcion: 'Recibe por correo electrónico la carta sorpresa de gilda.' },
    { id: 'papel', nombre: 'gilda de papel', precio: '10 €/mes', esGratis: false, enlaceStripe: 'https://buy.stripe.com/bJe8wJ7Yt50l1wIbBz6Ri04', descripcion: 'Recibe por correo postal la carta sorpresa de gilda.' },
    { id: 'virtual', nombre: 'gilda virtual', precio: '8 €/mes', esGratis: false, destacado: true, enlaceStripe: 'https://buy.stripe.com/bJe9ANguZ9gB6R27lj6Ri05', descripcion: 'Forma parte de la comunidad al completo y recibe todo el contenido digital.' },
    { id: 'absoluta', nombre: 'gilda absoluta', precio: '12 €/mes', esGratis: false, enlaceStripe: 'https://buy.stripe.com/14A5kxemReAV2AMcFD6Ri08', descripcion: 'Forma parte de la comunidad al completo y recibe todo en papel en tu buzón.' }
  ];

  const modalidadGratis = modalidades.find((m) => m.esGratis);
  const modalidadesPago = modalidades.filter((m) => !m.esGratis);

  const [seccionApp, setSeccionApp] = useState('inicio');
  const [subTabComunidad, setSubTabComunidad] = useState('chat');
  const restablecerNavegacion = () => {
    setSeccionApp('inicio');
    setSubTabComunidad('chat');
    setChatModo('global');
    setDestinatarioPrivado(null);
  };

  const cerrarSesion = () => {
    safeRemove('gilda_sesion');
    restablecerNavegacion();
    setSesion(null);
  };
  
  const [chatModo, setChatModo] = useState('global');
  const [destinatarioPrivado, setDestinatarioPrivado] = useState(null);
  const [nuevoChatPrivado, setNuevoChatPrivado] = useState('');

  const [tabEstanteria, setTabEstanteria] = useState('leyendo');
  const [toastMsg, setToastMsg] = useState(null);
  const [estadoNotificaciones, setEstadoNotificaciones] = useState('comprobando');
  const pushRegistrationListenerRef = useRef([]);
  const [mostrarModalUpgrade, setMostrarModalUpgrade] = useState(false);
  
  const [usuariasClub, setUsuariasClub] = useState(() => safeGetJSON('gilda_cache_usuarias', []));
  const [capitulos, setCapitulos] = useState(() => safeGetJSON('gilda_cache_capitulos', []));
  const [comentarios, setComentarios] = useState(() => safeGetJSON('gilda_cache_comentarios', []));
  const [lecturas, setLecturas] = useState(() => safeGetJSON('gilda_cache_lecturas', []));
  const [chatMsgs, setChatMsgs] = useState(() => safeGetJSON('gilda_cache_chat', []));
  const [propuestas, setPropuestas] = useState(() => safeGetJSON('gilda_cache_propuestas', []));
  const [lecturasPersonales, setLecturasPersonales] = useState(() => safeGetJSON('gilda_cache_personales', []));
  const [eventosCalendario, setEventosCalendario] = useState(() => safeGetJSON('gilda_cache_calendario', []));
  const [muroActividad, setMuroActividad] = useState(() => safeGetJSON('gilda_cache_muro', []));
  const [cafecitos, setCafecitos] = useState(() => safeGetJSON('gilda_cache_cafecitos', []));
  const [votacionCafecitos, setVotacionCafecitos] = useState(() => safeGetJSON('gilda_cache_votacion_cafe', []));
  const votosCafecitoEnCursoRef = useRef(new Set());
  const [nuevaPropuestaTitulo, setNuevaPropuestaTitulo] = useState('');
  const [nuevaPropuestaAutora, setNuevaPropuestaAutora] = useState('');
  const [nuevaPropuestaPortada, setNuevaPropuestaPortada] = useState('');

  const [miPagina, setMiPagina] = useState(0);
  const [miCiudadInput, setMiCiudadInput] = useState(() => safeGet('gilda_ciudad', ''));
  const [miCodigoPostalInput, setMiCodigoPostalInput] = useState(() => safeGet('gilda_codigo_postal', ''));
  const [isReadingNow, setIsReadingNow] = useState(() => safeGetJSON('gilda_is_reading', false));
  const [nombreUsuarioPersonalizado, setNombreUsuarioPersonalizado] = useState(() => safeGet('gilda_nombre_usuario', ''));
  const [fotoPerfilPersonalizada, setFotoPerfilPersonalizada] = useState(() => safeGet('gilda_foto_perfil', ''));

  const [libroPersonal, setLibroPersonal] = useState('');
  const [paginaPersonalInput, setPaginaPersonalInput] = useState('');
  const [decoracionActual, setDecoracionActual] = useState(() => safeGet('gilda_decoracion', 'monstera'));

  const [objetosPersonalizados, setObjetosPersonalizados] = useState(() => safeGetJSON('gilda_objetos_personalizados', [{ id: 'pin-1', url: null, titulo: 'Mi moodboard' }]));
  const [modalImportarAbierto, setModalImportarAbierto] = useState(false);
  const [objetoActivoParaImportar, setObjetoActivoParaImportar] = useState(null);

  const [sociaEscribiendo, setSociaEscribiendo] = useState(null);
  const timerEscribiendoRef = useRef(null);
  const ultimoEscribiendoKeyRef = useRef('');
  const datosActualesRef = useRef({});
  datosActualesRef.current = {
    usuarias: usuariasClub,
    capitulos,
    comentarios,
    lecturas,
    chat: chatMsgs,
    propuestas,
    personales: lecturasPersonales,
    calendario: eventosCalendario,
    muro: muroActividad,
    cafecitos,
    votacionCafecitos
  };

  const actualizarDatosSiCambian = (clave, datos, setter, cacheKey) => {
    if (JSON.stringify(datosActualesRef.current[clave]) === JSON.stringify(datos)) return;
    datosActualesRef.current[clave] = datos;
    setter(datos);
    safeSet(cacheKey, datos);
  };

  const manejarClickEnMarco = (id) => { setObjetoActivoParaImportar(id); setModalImportarAbierto(true); };
  const guardarEnlaceExterna = (id, nuevaUrl, nuevoTitulo) => {
     setObjetosPersonalizados(prev => {
       const actualizado = prev.map(obj => obj.id === id ? { ...obj, url: nuevaUrl, titulo: nuevoTitulo || obj.titulo } : obj);
       safeSet('gilda_objetos_personalizados', actualizado);
       return actualizado;
     });
     setModalImportarAbierto(false);
     mostrarToast('Marco actualizado con éxito');
  };
  const agregarNuevoMarco = () => {
    const nuevoId = `pin-${Date.now()}`;
    const actualizado = [...objetosPersonalizados, { id: nuevoId, url: null, titulo: 'Nuevo pin' }];
    setObjetosPersonalizados(actualizado);
    safeSet('gilda_objetos_personalizados', actualizado);
    mostrarToast('Nuevo marco añadido a la balda');
  };

  const [modoCreacionManual, setModoCreacionManual] = useState(false);
  const [manualTitulo, setManualTitulo] = useState('');
  const [manualAutora, setManualAutora] = useState('');
  const [manualPortada, setManualPortada] = useState('');

  const [libroSeleccionadoDetalle, setLibroSeleccionadoDetalle] = useState(null);
  const [editandoPortadaUrl, setEditandoPortadaUrl] = useState('');
  const [mostrarInputCorreccionPortada, setMostrarInputCorreccionPortada] = useState(false);
  const [estrellasSeleccionadas, setEstrellasSeleccionadas] = useState(5);

  const [misCitas] = useState(() => safeGetJSON('gilda_mis_citas', []));
  const [nuevoChat, setNuevoChat] = useState('');
  const [mensajeFundadora, setMensajeFundadora] = useState('');

  const [textoComentario, setTextoComentario] = useState({});
  const [respondiendoA, setRespondiendoA] = useState(null);
  const [textoRespuesta, setTextoRespuesta] = useState({});
  const chatEndRef = useRef(null);

  const mostrarToast = (texto) => { setToastMsg(texto); setTimeout(() => setToastMsg(null), 3000); };
  
  const parsearHoja = (url, datosLocales = []) => new Promise(resolve => {
    if ((reintentarCsvTras.get(url) || 0) > Date.now()) {
      resolve(csvCorrectoPorUrl.get(url) || datosLocales);
      return;
    }
    const urlAntiCache = url + (url.includes('?') ? '&' : '?') + '_t=' + Date.now();
    Papa.parse(urlAntiCache, { 
      download: true, 
      downloadRequestTimeout: 12000,
      header: true, 
      skipEmptyLines: true, 
      transformHeader: (h) => h.trim().toLowerCase(), 
      complete: (res) => {
        const datos = res.data || [];
        csvCorrectoPorUrl.set(url, datos);
        reintentarCsvTras.delete(url);
        resolve(datos);
      },
      error: () => {
        reintentarCsvTras.set(url, Date.now() + 30000);
        const datosAnteriores = csvCorrectoPorUrl.get(url) || datosLocales;
        csvCorrectoPorUrl.set(url, datosAnteriores);
        resolve(datosAnteriores);
      }
    });
  });

  const enviarAccion = async (action, payload) => {
    try {
      await fetch(GOOGLE_API_URL, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action, usuario: nombreUsuarioPersonalizado || sesion?.nombre, email: sesion?.email, timestamp: new Date().toISOString(), ...payload }),
      });
    } catch (err) { console.error(err); }
  };

  const registrarActividadPresencia = () => {
    if (!sesion || !sesion.email) return;
    const ahoraIso = new Date().toISOString();
    enviarAccion('actualizar_conexion', { email: sesion.email });
    setUsuariasClub(prev => prev.map(u => {
      if ((u.email || '').trim().toLowerCase() === sesion.email.toLowerCase()) {
        return { ...u, ultima_conexion: ahoraIso };
      }
      return u;
    }));
  };

  const votarCafecito = (cafecito) => {
    const fecha = String(cafecito.fecha || '').trim();
    const email = String(sesion?.email || '').trim().toLowerCase();
    if (!fecha || !email) {
      mostrarToast('No se puede registrar el voto: faltan datos de fecha o sesión.');
      return;
    }

    const fechaKey = normalizarUbicacion(fecha);
    if (votosCafecitoEnCursoRef.current.has(fechaKey)) return;
    votosCafecitoEnCursoRef.current.add(fechaKey);

    const votoActual = votacionCafecitos.find(v => normalizarUbicacion(v.fecha) === fechaKey);
    const votantesActuales = [...new Set(String(votoActual?.votantes || '').split(/[;,]/).map(v => v.trim().toLowerCase()).filter(Boolean))];
    const yaVoto = votantesActuales.includes(email);
    const votantesNuevos = yaVoto ? votantesActuales.filter(v => v !== email) : [...votantesActuales, email];
    const votosRegistrados = Number(votoActual?.votos);
    const totalActual = Number.isFinite(votosRegistrados) && String(votoActual?.votos ?? '').trim() !== ''
      ? votosRegistrados
      : votantesActuales.length;
    const totalNuevo = Math.max(0, totalActual + (yaVoto ? -1 : 1));
    const nuevoRegistro = { fecha, votos: String(totalNuevo), votantes: votantesNuevos.join(',') };
    const nuevaVotacion = votoActual
      ? votacionCafecitos.map(v => normalizarUbicacion(v.fecha) === fechaKey ? nuevoRegistro : v)
      : [...votacionCafecitos, nuevoRegistro];

    setVotacionCafecitos(nuevaVotacion);
    safeSet('gilda_cache_votacion_cafe', nuevaVotacion);
    enviarAccion('votar', {
      tipo: 'cafecito',
      id: fecha,
      fecha,
      email,
      votos: totalNuevo,
      votantes: votantesNuevos.join(',')
    });
    registrarActividadPresencia();
    mostrarToast(yaVoto ? 'Has retirado tu voto.' : '¡Tu voto para el cafecito está registrado!');
    setTimeout(() => votosCafecitoEnCursoRef.current.delete(fechaKey), 600);
  };

  const activarNotificaciones = async () => {
    setEstadoNotificaciones('solicitando');
    try {
      const capacitor = window.Capacitor;
      const plataformaNativa = capacitor?.isNativePlatform?.()
        || ['android', 'ios'].includes(capacitor?.getPlatform?.());
      if (plataformaNativa) {
        const { PushNotifications } = await import('@capacitor/push-notifications');
        const permisos = await PushNotifications.requestPermissions();
        if (permisos.receive !== 'granted') {
          setEstadoNotificaciones('denegadas');
          mostrarToast('Activa las notificaciones desde los ajustes del dispositivo.');
          return;
        }
        if (pushRegistrationListenerRef.current.length === 0) {
          pushRegistrationListenerRef.current = await Promise.all([
            PushNotifications.addListener('registration', token => {
              enviarAccion('registrar_token_push', { token: token.value, plataforma: capacitor.getPlatform?.() || 'capacitor' });
            }),
            PushNotifications.addListener('registrationError', error => {
              console.error('Error al registrar el token push:', error);
              setEstadoNotificaciones('error');
            }),
            PushNotifications.addListener('pushNotificationReceived', notification => {
              mostrarToast(notification.body || notification.title || 'Tienes una novedad del club.');
            }),
            PushNotifications.addListener('pushNotificationActionPerformed', action => {
              const ruta = action.notification?.data?.url;
              if (ruta) window.location.assign(new URL(ruta, window.location.origin).href);
            })
          ]);
        }
        await PushNotifications.register();
        safeSet('gilda_notificaciones_activas', true);
        setEstadoNotificaciones('nativas-activadas');
        mostrarToast('Solicitud de notificaciones enviada al dispositivo.');
        return;
      }

      if (!('Notification' in window) || !('serviceWorker' in navigator)) {
        setEstadoNotificaciones('no-compatible');
        mostrarToast('Este dispositivo no admite notificaciones web.');
        return;
      }

      const permiso = await Notification.requestPermission();
      if (permiso !== 'granted') {
        setEstadoNotificaciones('denegadas');
        mostrarToast('No se concedió permiso para las notificaciones.');
        return;
      }

      const registration = await navigator.serviceWorker.ready;
      const claveVapid = import.meta.env.VITE_VAPID_PUBLIC_KEY;
      let subscription = await registration.pushManager?.getSubscription();
      if (!subscription && claveVapid && registration.pushManager) {
        const claveBase64 = claveVapid.replace(/-/g, '+').replace(/_/g, '/');
        const claveBinaria = atob(claveBase64.padEnd(Math.ceil(claveBase64.length / 4) * 4, '='));
        const applicationServerKey = Uint8Array.from(claveBinaria, caracter => caracter.charCodeAt(0));
        subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
      }

      safeSet('gilda_notificaciones_activas', true);
      if (subscription) {
        enviarAccion('registrar_suscripcion_push', { suscripcion: subscription.toJSON(), plataforma: 'web' });
        setEstadoNotificaciones('push-activadas');
        mostrarToast('Suscripción push registrada.');
      } else {
        setEstadoNotificaciones('permiso-concedido');
        mostrarToast('Permiso activado; la entrega push requiere configurar VITE_VAPID_PUBLIC_KEY y el servidor.');
      }
    } catch (error) {
      console.error('No se pudieron activar las notificaciones:', error);
      setEstadoNotificaciones('error');
      mostrarToast('No se pudieron activar las notificaciones.');
    }
  };

  const registrarActividadPresenciaRef = useRef(registrarActividadPresencia);
  registrarActividadPresenciaRef.current = registrarActividadPresencia;

  const manejarTipeoChat = () => {
    if (!sesion) return;
    enviarAccion('gilda_escribiendo', { 
      escribiendo: true,
      usuario: nombreUsuarioPersonalizado || sesion.nombre,
      email: sesion.email,
      modoChat: chatModo,
      destinatario: destinatarioPrivado ? destinatarioPrivado.email : null
    });
  };

  useEffect(() => {
    if (sesion) {
      registrarActividadPresenciaRef.current();
      const pingInterval = setInterval(() => registrarActividadPresenciaRef.current(), 60000);
      return () => clearInterval(pingInterval);
    }
  }, [sesion]);

  const obtenerNombreReal = (emailComentario, usuarioOriginal) => {
    if (sesion && sesion.email && emailComentario && sesion.email.toLowerCase() === emailComentario.toLowerCase()) {
      if (nombreUsuarioPersonalizado) return nombreUsuarioPersonalizado;
    }
    if (emailComentario) {
      const encontrada = usuariasClub.find(u => (u.email || '').trim().toLowerCase() === emailComentario.trim().toLowerCase());
      if (encontrada && encontrada.nombre && encontrada.nombre.trim() !== '') return encontrada.nombre.trim();
    }
    if (usuarioOriginal && !usuarioOriginal.includes('@') && usuarioOriginal !== 'Lector/a' && usuarioOriginal !== 'Lector(a)' && usuarioOriginal !== 'Socia') {
      return usuarioOriginal;
    }
    return (sesion && sesion.nombre) || (emailComentario ? emailComentario.split('@')[0] : 'Socia');
  };

  const obtenerNombreRealRef = useRef(obtenerNombreReal);
  obtenerNombreRealRef.current = obtenerNombreReal;

  const handleFotoPerfilUpdate = (base64Img) => {
    setFotoPerfilPersonalizada(base64Img);
    safeSet('gilda_foto_perfil', base64Img);
    enviarAccion('actualizar_foto_perfil', { foto_perfil: base64Img });
    registrarActividadPresencia();
    mostrarToast('Foto de perfil actualizada');
  };

  const handleInteractuarIlustracion = (tipo) => {
    const mensajes = {
      monstera: "🌱 ¡Tu plantita está creciendo tan feliz como tus lecturas!",
      maceta: "🪴 Una maceta de cerámica perfecta para inspirar tus páginas.",
      vela: "🕯️ La vela ilumina suavemente tu rincón de lectura favorito.",
      cafe: "☕ Un cafecito caliente para acompañar cada capítulo.",
      cactus: "🌵 Un pequeño cactus resistente para decorar tu balda.",
      auriculares: "🎧 Unos auriculares listos para tu playlist de lectura cozy.",
      tocadiscos: "🎶 Sonando música suave en tu tocadiscos vintage.",
      camara: "📷 Capturando instantes analógicos de tus libros.",
      lampara: "💡 Iluminación perfecta para leer hasta tarde."
    };
    mostrarToast(mensajes[tipo] || "¡Qué bonito rincón!");
  };

  const publicarCitaEnMuro = (texto, libroCita) => {
    const cita = String(texto || '').trim();
    if (!cita || !sesion?.email) return;
    const publicacion = {
      tipo: 'cita',
      cita,
      email: sesion.email,
      nombre: nombreUsuarioPersonalizado || sesion.nombre,
      libro: libroCita?.titulo || '',
      portada: libroCita?.portada || '',
      estrellas: 0,
      timestamp: new Date().toISOString()
    };
    const muroActualizado = [publicacion, ...muroActividad];
    setMuroActividad(muroActualizado);
    safeSet('gilda_cache_muro', muroActualizado);
    enviarAccion('publicar_cita', publicacion);
    registrarActividadPresencia();
    mostrarToast('Tu cita ya está publicada en el Muro.');
  };

  useEffect(() => {
    let cargaEnCurso = false;
    const cargarDatosSilenciosos = () => {
      if (cargaEnCurso) return;
      cargaEnCurso = true;
      Promise.all([
        parsearHoja(URL_CSV_USUARIAS, safeGetJSON('gilda_cache_usuarias', [])),
        parsearHoja(URL_CSV_CAPITULOS, safeGetJSON('gilda_cache_capitulos', [])),
        parsearHoja(URL_CSV_COMENTARIOS, safeGetJSON('gilda_cache_comentarios', [])),
        parsearHoja(URL_CSV_LECTURAS, safeGetJSON('gilda_cache_lecturas', [])),
        parsearHoja(URL_CSV_PROPUESTAS, safeGetJSON('gilda_cache_propuestas', [])),
        parsearHoja(URL_CSV_LECTURAS_PERSONALES, safeGetJSON('gilda_cache_personales', [])),
        parsearHoja(URL_CSV_CALENDARIO, safeGetJSON('gilda_cache_calendario', [])),
        parsearHoja(URL_CSV_MURO, safeGetJSON('gilda_cache_muro', [])),
        parsearHoja(URL_CSV_CAFECITOS, safeGetJSON('gilda_cache_cafecitos', [])),
        parsearHoja(URL_CSV_VOTACION_CAFE, safeGetJSON('gilda_cache_votacion_cafe', []))
      ]).then(results => {
        if (!activo) return;
        const listaUsuarias = results[0].filter(u => (u.email || '').trim() !== '');
        actualizarDatosSiCambian('usuarias', listaUsuarias, setUsuariasClub, 'gilda_cache_usuarias');
        
        if (sesion && sesion.email) {
          const sociaActual = listaUsuarias.find(u => (u.email || '').trim().toLowerCase() === sesion.email.trim().toLowerCase());
          if (sociaActual) {
            if (sociaActual.nombre && sociaActual.nombre.trim() !== '') {
              setNombreUsuarioPersonalizado(sociaActual.nombre.trim());
              safeSet('gilda_nombre_usuario', sociaActual.nombre.trim());
            }
            if (sociaActual.pagina !== undefined && sociaActual.pagina !== '') {
              setMiPagina(Number(sociaActual.pagina) || 0);
            }
            if (sociaActual.ciudad && !safeGet('gilda_ciudad', '')) setMiCiudadInput(sociaActual.ciudad);
            if (sociaActual.codigo_postal && !safeGet('gilda_codigo_postal', '')) setMiCodigoPostalInput(sociaActual.codigo_postal);
            if (sociaActual.foto_perfil && !safeGet('gilda_foto_perfil', '')) setFotoPerfilPersonalizada(sociaActual.foto_perfil);
          }
        }

        actualizarDatosSiCambian('capitulos', results[1], setCapitulos, 'gilda_cache_capitulos');
        
        actualizarDatosSiCambian('comentarios', results[2], setComentarios, 'gilda_cache_comentarios');
        
        actualizarDatosSiCambian('lecturas', results[3], setLecturas, 'gilda_cache_lecturas');

        actualizarDatosSiCambian('propuestas', results[4], setPropuestas, 'gilda_cache_propuestas');
        
        actualizarDatosSiCambian('personales', results[5], setLecturasPersonales, 'gilda_cache_personales');
        
        actualizarDatosSiCambian('calendario', results[6], setEventosCalendario, 'gilda_cache_calendario');

        const servidorMuro = results[7] || [];
        actualizarDatosSiCambian('muro', servidorMuro, setMuroActividad, 'gilda_cache_muro');
        actualizarDatosSiCambian('cafecitos', results[8], setCafecitos, 'gilda_cache_cafecitos');
        actualizarDatosSiCambian('votacionCafecitos', results[9], setVotacionCafecitos, 'gilda_cache_votacion_cafe');
      }).finally(() => { cargaEnCurso = false; });
    };

    let activo = true;
    cargarDatosSilenciosos();
    const interval = sesion ? setInterval(cargarDatosSilenciosos, 15000) : null;
    return () => {
      activo = false;
      if (interval) clearInterval(interval);
    };
  }, [sesion]);

  useEffect(() => {
    if (!sesion?.email) return undefined;
    let activo = true;
    let cargaChatEnCurso = false;
    const cargarChatRapido = () => {
      if (!activo || cargaChatEnCurso) return;
      cargaChatEnCurso = true;
      parsearHoja(URL_CSV_CHAT, safeGetJSON('gilda_cache_chat', []))
        .then(servidorMsgs => {
          if (!activo) return;
          const mensajes = Array.isArray(servidorMsgs) ? servidorMsgs : [];
          const miEmail = sesion.email.trim().toLowerCase();
          const ultimoEscribiendo = mensajes.slice().reverse().find(m =>
            (m.action === 'gilda_escribiendo' || m.tipo === 'escribiendo') &&
            (m.email || '').toLowerCase().trim() !== miEmail
          );
          const instanteTipeo = Date.parse(ultimoEscribiendo?.timestamp || ultimoEscribiendo?.fecha || '');
          const tipeoReciente = ultimoEscribiendo && Number.isFinite(instanteTipeo)
            && Date.now() >= instanteTipeo && Date.now() - instanteTipeo < 7000;
          const claveTipeo = tipeoReciente ? `${ultimoEscribiendo.email}:${instanteTipeo}` : '';

          if (claveTipeo && claveTipeo !== ultimoEscribiendoKeyRef.current) {
            ultimoEscribiendoKeyRef.current = claveTipeo;
            setSociaEscribiendo(obtenerNombreRealRef.current(ultimoEscribiendo.email, ultimoEscribiendo.usuario));
            if (timerEscribiendoRef.current) clearTimeout(timerEscribiendoRef.current);
            timerEscribiendoRef.current = setTimeout(() => {
              ultimoEscribiendoKeyRef.current = '';
              setSociaEscribiendo(null);
            }, 4000);
          } else if (!tipeoReciente && ultimoEscribiendoKeyRef.current) {
            ultimoEscribiendoKeyRef.current = '';
            if (timerEscribiendoRef.current) clearTimeout(timerEscribiendoRef.current);
            setSociaEscribiendo(null);
          }

          const filtradosServidor = mensajes.filter(m =>
            m.action !== 'gilda_escribiendo' && m.tipo !== 'escribiendo' && m.mensaje && m.mensaje.trim() !== ''
          );
          actualizarDatosSiCambian('chat', filtradosServidor, setChatMsgs, 'gilda_cache_chat');
        })
        .finally(() => { cargaChatEnCurso = false; });
    };

    cargarChatRapido();
    const intervaloChat = setInterval(cargarChatRapido, 3000);
    return () => {
      activo = false;
      clearInterval(intervaloChat);
    };
  }, [sesion]);

  useEffect(() => () => {
    if (timerEscribiendoRef.current) clearTimeout(timerEscribiendoRef.current);
  }, []);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) {
      const capacitor = window.Capacitor;
      const plataformaNativa = capacitor?.isNativePlatform?.()
        || ['android', 'ios'].includes(capacitor?.getPlatform?.());
      setEstadoNotificaciones(plataformaNativa ? 'desactivadas' : 'no-compatible');
      return undefined;
    }

    let activo = true;
    navigator.serviceWorker.register('/sw.js')
      .then(() => {
        if (!activo) return;
        const permiso = 'Notification' in window ? Notification.permission : 'default';
        setEstadoNotificaciones(permiso === 'granted' ? 'permiso-concedido' : 'desactivadas');
      })
      .catch(error => {
        console.error('No se pudo registrar el Service Worker:', error);
        if (activo) setEstadoNotificaciones('error');
      });

    return () => {
      activo = false;
      pushRegistrationListenerRef.current.forEach(listener => listener.remove?.());
      pushRegistrationListenerRef.current = [];
    };
  }, []);

  useEffect(() => {
    if (subTabComunidad === 'chat') chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMsgs, subTabComunidad, chatModo, destinatarioPrivado, sociaEscribiendo]);

  useEffect(() => {
    if (seccionApp === 'comunidad' && subTabComunidad === 'chat') {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [seccionApp, subTabComunidad]);

  const registrarYRedirigir = async (e) => {
    e.preventDefault();
    setEnviandoRegistro(true);
    const form = e.target;
    const formData = new FormData(form);
    const nombreSocia = String(formData.get('Nombre') || '').trim();
    const emailSocia = String(formData.get('Email') || '').trim().toLowerCase();
    const modalidadNombreCompleto = `${modalidadSeleccionada.nombre} (${modalidadSeleccionada.precio})`;

    if (modalidadSeleccionada.esGratis) {
      const datosRegistro = { action: 'registrar_nueva_socia', nombre: nombreSocia, email: emailSocia, modalidad: modalidadNombreCompleto, timestamp: new Date().toISOString() };
      try {
        await fetch(GOOGLE_API_URL, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(datosRegistro) });
      } catch (error) {
        console.error('No se pudo enviar el registro a Apps Script:', error);
        setEnviandoRegistro(false);
        mostrarToast('No se pudo enviar el registro. Comprueba tu conexión e inténtalo de nuevo.');
        return;
      }
      setEnviandoRegistro(false);

      const nombreSociaSheet = (nombreSocia && nombreSocia.trim() !== '') ? nombreSocia.trim() : emailSocia.split('@')[0];
      const datosSesion = { nombre: nombreSociaSheet, email: emailSocia, modalidad: modalidadNombreCompleto };
      const nuevaUsuariaLocal = { nombre: nombreSociaSheet, email: emailSocia, modalidad: modalidadNombreCompleto, pagina: '0', ciudad: '', codigo_postal: '', foto_perfil: '', ultima_conexion: new Date().toISOString() };
      setUsuariasClub(prev => [...prev, nuevaUsuariaLocal]);

      safeSet('gilda_sesion', datosSesion);
      safeSet('gilda_nombre_usuario', nombreSociaSheet);
      setNombreUsuarioPersonalizado(nombreSociaSheet);
      setMiPagina(0);
      restablecerNavegacion();
      setSesion(datosSesion);
      mostrarToast('¡Registro completado! Bienvenida a gilda.');
    } else {
      try {
        const enlaceStripe = new URL(modalidadSeleccionada.enlaceStripe);
        if (enlaceStripe.hostname !== 'buy.stripe.com') throw new Error('Enlace Stripe no válido');
        enlaceStripe.searchParams.set('prefilled_email', emailSocia);
        window.location.assign(enlaceStripe.toString());
      } catch (error) {
        console.error('No se pudo abrir el enlace de pago:', error);
        setEnviandoRegistro(false);
        mostrarToast('No se pudo abrir el pago. Vuelve a elegir la modalidad.');
      }
    }
  };

  const guardarLibroPersonal = (tituloOpt, pagOpt, estadoOpt = 'leyendo', autoraOpt = '', portadaOpt = '') => {
    registrarActividadPresencia();
    const tituloLibro = (tituloOpt !== undefined ? tituloOpt : libroPersonal).trim();
    if (!tituloLibro) return;
    const itemExistente = lecturasPersonales.find(l => (l.email || '').toLowerCase() === sesion.email.toLowerCase() && ((l.libro || l.titulo || '').toLowerCase() === tituloLibro.toLowerCase()));
    const pagFinal = pagOpt !== undefined ? (Number(pagOpt) || 0) : (itemExistente ? (Number(itemExistente.pagina || itemExistente.paginas) || 0) : (Number(paginaPersonalInput) || 0));

    const clon = [...lecturasPersonales];
    const idx = clon.findIndex(l => (l.email || '').toLowerCase() === sesion.email.toLowerCase() && ((l.libro || l.titulo || '').toLowerCase() === tituloLibro.toLowerCase()));
    if (idx > -1) {
      clon[idx].pagina = pagFinal; clon[idx].paginas = pagFinal; clon[idx].estado = estadoOpt;
      if (autoraOpt) clon[idx].autora = autoraOpt; if (portadaOpt) clon[idx].portada = portadaOpt;
    } else {
      clon.push({ email: sesion.email, nombre: nombreUsuarioPersonalizado || sesion.nombre, libro: tituloLibro, pagina: pagFinal, paginas: pagFinal, estado: estadoOpt, autora: autoraOpt, portada: portadaOpt });
    }
    setLecturasPersonales(clon); setLibroPersonal(''); setPaginaPersonalInput(''); setModoCreacionManual(false);
    enviarAccion('actualizar_libro_personal', { email: sesion.email, libro: tituloLibro, pagina: pagFinal, estado: estadoOpt, autora: autoraOpt, portada: portadaOpt });
    mostrarToast(`Guardado: ${tituloLibro}`);
  };

  const adminGuardarLecturaActiva = (event) => {
    event.preventDefault();
    if (!esAdministradora) return;
    const formData = new FormData(event.currentTarget);
    const lectura = {
      ...libroActual,
      titulo: String(formData.get('titulo') || '').trim(),
      autora: String(formData.get('autora') || '').trim(),
      portada: String(formData.get('portada') || '').trim(),
      paginas_totales: Number(formData.get('paginas_totales')) || 0
    };
    if (!lectura.titulo) {
      mostrarToast('El título de la lectura activa es obligatorio.');
      return;
    }
    const lecturasActualizadas = lecturas.length ? [lectura, ...lecturas.slice(1)] : [lectura];
    setLecturas(lecturasActualizadas);
    safeSet('gilda_cache_lecturas', lecturasActualizadas);
    enviarAccion('actualizar_lectura_club', { lectura, email_admin: EMAIL_ADMINISTRADORA });
    mostrarToast('Lectura activa actualizada manualmente.');
  };

  const adminEliminarMensajeChat = (indice) => {
    if (!esAdministradora || !chatMsgs[indice]) return;
    const mensaje = chatMsgs[indice];
    const chatActualizado = chatMsgs.filter((_, index) => index !== indice);
    setChatMsgs(chatActualizado);
    safeSet('gilda_cache_chat', chatActualizado);
    enviarAccion('moderar_chat', {
      operacion: 'eliminar',
      id: mensaje.id || mensaje.timestamp || `${mensaje.email || ''}:${mensaje.mensaje || ''}`,
      email_mensaje: mensaje.email || '',
      mensaje: mensaje.mensaje || '',
      email_admin: EMAIL_ADMINISTRADORA
    });
    mostrarToast('Mensaje retirado de esta vista.');
  };

  const adminEliminarPropuesta = (indice) => {
    if (!esAdministradora || !propuestas[indice]) return;
    const propuesta = propuestas[indice];
    const propuestasActualizadas = propuestas.filter((_, index) => index !== indice);
    setPropuestas(propuestasActualizadas);
    safeSet('gilda_cache_propuestas', propuestasActualizadas);
    enviarAccion('gestionar_propuesta', {
      operacion: 'eliminar',
      id: propuesta.id || propuesta.titulo,
      titulo: propuesta.titulo,
      email_admin: EMAIL_ADMINISTRADORA
    });
    mostrarToast('Propuesta retirada de esta vista.');
  };

  const adminAlternarCapitulo = (indice) => {
    if (!esAdministradora || !capitulos[indice]) return;
    const capitulo = capitulos[indice];
    const oculto = ['oculto', 'borrador'].includes(String(capitulo.estado || '').toLowerCase());
    const estado = oculto ? 'publicado' : 'oculto';
    const capitulosActualizados = capitulos.map((item, index) => index === indice ? { ...item, estado } : item);
    setCapitulos(capitulosActualizados);
    safeSet('gilda_cache_capitulos', capitulosActualizados);
    enviarAccion('validar_capitulo', {
      id: capitulo.id || capitulo.titulo,
      titulo: capitulo.titulo,
      estado,
      email_admin: EMAIL_ADMINISTRADORA
    });
    mostrarToast(estado === 'publicado' ? 'Capítulo publicado en esta vista.' : 'Capítulo ocultado en esta vista.');
  };

  const libroActual = useMemo(() => lecturas[0] || { titulo: 'La campana de cristal', autora: 'Sylvia Plath', paginas_totales: 280, portada: '' }, [lecturas]);
  const porcentajeLibro = useMemo(() => Math.min(Math.round((miPagina / Number(libroActual.paginas_totales || 280)) * 100), 100), [miPagina, libroActual]);
  
  const todosMisLibrosEstanteria = useMemo(() => {
    if (!sesion) return [];
    return lecturasPersonales.filter(l => (l.email || '').toLowerCase() === sesion.email.toLowerCase());
  }, [lecturasPersonales, sesion]);

  const librosBibliotecaVisibles = useMemo(() => (
    todosMisLibrosEstanteria.filter(item => (item.estado || 'leyendo') === tabEstanteria)
  ), [todosMisLibrosEstanteria, tabEstanteria]);

  const cafecitosConVotos = useMemo(() => {
    const opciones = cafecitos.map(cafecito => {
      const fechaKey = normalizarUbicacion(cafecito.fecha);
      const registro = votacionCafecitos.find(v => normalizarUbicacion(v.fecha) === fechaKey);
      const votantes = [...new Set(String(registro?.votantes || '').split(/[;,]/).map(v => v.trim().toLowerCase()).filter(Boolean))];
      const votos = Number(registro?.votos);
      return {
        ...cafecito,
        votos: Number.isFinite(votos) && String(registro?.votos ?? '').trim() !== '' ? votos : votantes.length,
        votantes,
        yaVoto: votantes.includes(String(sesion?.email || '').trim().toLowerCase())
      };
    });
    const totalVotos = opciones.reduce((suma, opcion) => suma + opcion.votos, 0);
    return opciones.map(opcion => ({
      ...opcion,
      porcentaje: totalVotos ? Math.round((opcion.votos / totalVotos) * 100) : 0
    }));
  }, [cafecitos, votacionCafecitos, sesion]);

  const miembrosEdificio = useMemo(() => {
    return usuariasClub.map(u => {
      const emailU = (u.email || '').toLowerCase().trim();
      const esYo = emailU === (sesion?.email || '').toLowerCase().trim();
      const nombreRealU = u.nombre ? u.nombre.trim() : 'Lector(a)';
      const misPersonales = lecturasPersonales.filter(l => (l.email || '').toLowerCase().trim() === emailU && (l.estado || 'leyendo') === 'leyendo');
      return {
        ...u,
        nombre: esYo ? (nombreUsuarioPersonalizado || nombreRealU) : nombreRealU,
        foto_perfil: esYo ? (fotoPerfilPersonalizada || u.foto_perfil) : u.foto_perfil,
        pagina: esYo ? miPagina : Number(u.pagina || 0),
        estaLeyendo: esYo ? isReadingNow : (Number(u.pagina || 0) > 0 || misPersonales.length > 0),
        misLecturasPersonales: misPersonales
      };
    });
  }, [usuariasClub, sesion, nombreUsuarioPersonalizado, fotoPerfilPersonalizada, miPagina, isReadingNow, lecturasPersonales]);

  const cantidadSociasEnLinea = useMemo(() => {
    return usuariasClub.filter(u => calcularEstadoConexion(u.ultima_conexion) === 'conectada').length;
  }, [usuariasClub]);

  const modalidadLimpia = (sesion?.modalidad || '').toLowerCase().trim();
  const modalidadNormalizada = modalidadLimpia.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const esModalidadCorreo = modalidadNormalizada.includes('nube') || modalidadNormalizada.includes('papel');
  const esRestringida = modalidadNormalizada.includes('cotilla') || modalidadNormalizada.includes('satelite');
  const esAdministradora = String(sesion?.email || '').trim().toLowerCase() === EMAIL_ADMINISTRADORA;

  if (!sesion) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 w-full py-12 bg-[#ffffee]">
        <div className="editorial-card max-w-md w-full p-8 sm:p-10 space-y-6 text-center relative overflow-hidden shadow-xl border border-[#e6e4dc]">
          <div className="absolute top-0 left-0 right-0 h-1 bg-[#3d4220]"></div>
          <div className="space-y-1.5 pt-2">
            <p className="text-[10px] uppercase tracking-[0.35em] text-[#3d4220]/80 font-bold font-sans mb-1 max-w-[220px] mx-auto leading-relaxed">
  comunidad de lectura<br />cartas y creatividad
</p>
<h1 className="font-babydoll text-8xl text-[#1c1c1a] font-bold tracking-tight">gilda</h1>
          </div>

          {vistaAcceso === 'menu' && (
            <div className="space-y-6 pt-2 fade-in">
              <div className="flex bg-[#f5f2e6] p-1 rounded-xl border border-[#e6e4dc] font-sans">
                <button onClick={() => setTabActiva('login')} className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all ${tabActiva === 'login' ? 'bg-white text-[#1c1c1a] shadow-sm' : 'text-[#595750]'}`}>Ya tengo cuenta</button>
                <button onClick={() => setTabActiva('registro')} className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all ${tabActiva === 'registro' ? 'bg-white text-[#1c1c1a] shadow-sm' : 'text-[#595750]'}`}>Unirme al club</button>
              </div>

              {tabActiva === 'login' ? (
                <form onSubmit={(e) => {
                  e.preventDefault();
                  setErrorLogin('');
                  const emailLimpio = inputEmail.trim().toLowerCase();
                  const socia = usuariasClub.find(u => (u.email || '').trim().toLowerCase() === emailLimpio);
                  if (!socia) return setErrorLogin('Correo no registrado.');
                  
                  const modUser = (socia.modalidad || '').toLowerCase().trim();
                  if ((modUser.includes('nube') || modUser.includes('papel')) && emailLimpio !== EMAIL_ADMINISTRADORA) return setErrorLogin('Tu modalidad es exclusiva para correo y no incluye acceso a la web.');

                  const passwordRegistrada = (socia.password || '').trim();
                  if (passwordRegistrada !== '' && passwordRegistrada !== inputPassword.trim()) return setErrorLogin('Contraseña incorrecta.');
                  if (passwordRegistrada === '') {
                    if (!inputPassword.trim()) return setErrorLogin('Introduce una contraseña nueva para guardarla.');
                    enviarAccion('actualizar_password', { email: emailLimpio, password: inputPassword.trim() });
                  }

                  const nombreSociaSheet = (socia.nombre && socia.nombre.trim() !== '') ? socia.nombre.trim() : inputEmail.split('@')[0];
                  const datosSesion = { nombre: nombreSociaSheet, email: emailLimpio, modalidad: socia.modalidad || 'gilda' };
                  safeSet('gilda_sesion', datosSesion);
                  safeSet('gilda_nombre_usuario', nombreSociaSheet);
                  setNombreUsuarioPersonalizado(nombreSociaSheet);
                  setMiPagina(Number(socia.pagina || 0));
                  restablecerNavegacion();
                  setSesion(datosSesion);
                }} className="space-y-4 font-sans text-left">
                  <div className="space-y-1">
                    <label className="block text-xs font-semibold text-[#1c1c1a]">Correo electrónico</label>
                    <input type="email" placeholder="tu@correo.com" value={inputEmail} onChange={e => setInputEmail(e.target.value)} required className="w-full editorial-input px-3.5 py-3 text-xs" />
                  </div>
                  <div className="space-y-1 relative">
                    <label className="block text-xs font-semibold text-[#1c1c1a]">Contraseña</label>
                    <div className="relative flex items-center">
                      <input type={mostrarPass ? "text" : "password"} placeholder="••••••••" value={inputPassword} onChange={e => setInputPassword(e.target.value)} required className="w-full editorial-input px-3.5 py-3 text-xs pr-10" />
                      <button type="button" onClick={() => setMostrarPass(!mostrarPass)} className="absolute right-3 text-gray-400 hover:text-black text-xs">
                        <i className={`fa-solid ${mostrarPass ? 'fa-eye-slash' : 'fa-eye'}`}></i>
                      </button>
                    </div>
                  </div>
                  {errorLogin && (
                    <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-center">
                      <p className="text-xs text-red-600 font-sans">{errorLogin}</p>
                    </div>
                  )}
                  <button type="submit" className="w-full editorial-btn py-3 text-sm shadow-md mt-2">Entrar a mi habitación</button>
                </form>
              ) : (
                <div className="space-y-4 text-left font-sans">
                  <div className="bg-[#f5f2e6] p-4 rounded-2xl border border-[#e6e4dc] space-y-2 text-center">
                    <p className="font-babydoll text-lg text-[#1c1c1a] leading-snug">Un lugar seguro para leer en compañía, charlar sobre libros y disfrutar de cafecitos virtuales.</p>
                  </div>
                  <div className="space-y-2.5 pt-1">
                    <button onClick={() => { setModalidadSeleccionada(modalidadGratis || modalidades[0]); setVistaAcceso('formulario_registro'); }} className="w-full editorial-btn py-3 text-xs shadow-sm flex items-center justify-center gap-2">
                      <span>Abrir puerta gratis para cotillear</span>
                      <i className="fa-solid fa-arrow-right text-xs"></i>
                    </button>
                    <button onClick={() => setVistaAcceso('modalidades')} className="w-full bg-white text-[#3d4220] border border-[#d4cfbc] rounded-2xl py-3 text-xs font-bold transition-all hover:bg-[#faf9f5] text-center shadow-sm">
                      Conocer las modalidades del club
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {vistaAcceso === 'modalidades' && (
            <div className="space-y-4 fade-in text-left">
              <button onClick={() => setVistaAcceso('menu')} className="text-xs font-semibold text-[#595750] hover:text-[#1c1c1a] flex items-center group font-sans">
                <i className="fa-solid fa-arrow-left mr-2 text-xs"></i> Volver
              </button>
              <h2 className="text-2xl font-babydoll font-bold text-center text-[#1c1c1a]">Elige tu favorita</h2>
              <div className="space-y-3 max-h-80 overflow-y-auto pr-1">
                <div className="editorial-card p-4 flex flex-col justify-between bg-white">
                  <div className="flex justify-between items-start mb-1.5">
                    <h3 className="font-babydoll font-bold text-lg text-[#1c1c1a]">{modalidadGratis.nombre}</h3>
                    <span className="text-xs font-bold bg-[#ffffee] text-[#3d4220] px-2.5 py-1 rounded-full border border-[#d4cfbc]">{modalidadGratis.precio}</span>
                  </div>
                  <p className="text-xs text-[#595750] font-sans mb-3.5 leading-relaxed">{modalidadGratis.descripcion}</p>
                  <button onClick={() => { setModalidadSeleccionada(modalidadGratis); setVistaAcceso('formulario_registro'); }} className="w-full py-2.5 rounded-xl text-xs font-semibold bg-[#faf9f5] border border-[#e6e4dc] text-[#1c1c1a]">Seleccionar</button>
                </div>
                {modalidadesPago.map((mod, index) => (
                  <div key={index} className={`editorial-card p-4 flex flex-col justify-between ${mod.destacado ? 'border-[#3d4220] border-2 bg-[#ffffee]/30' : 'bg-white'}`}>
                    <div className="flex justify-between items-start mb-1.5">
                      <h3 className="font-babydoll font-bold text-lg text-[#1c1c1a]">{mod.nombre}</h3>
                      <span className="text-xs font-bold bg-[#3d4220] text-white px-2.5 py-1 rounded-full">{mod.precio}</span>
                    </div>
                    <p className="text-xs text-[#595750] font-sans mb-3.5 leading-relaxed">{mod.descripcion}</p>
                    <button onClick={() => { setModalidadSeleccionada(mod); setVistaAcceso('formulario_registro'); }} className={`w-full py-2.5 rounded-xl text-xs font-semibold ${mod.destacado ? 'editorial-btn' : 'bg-[#faf9f5] border border-[#e6e4dc] text-[#1c1c1a]'}`}>Seleccionar</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {vistaAcceso === 'formulario_registro' && modalidadSeleccionada && (
            <div className="space-y-4 fade-in text-left">
              <button onClick={() => setVistaAcceso('modalidades')} className="text-xs font-semibold text-[#595750] hover:text-[#1c1c1a] flex items-center group font-sans">
                <i className="fa-solid fa-arrow-left mr-2 text-xs"></i> Volver
              </button>
              <div className="border-b border-[#e6e4dc] pb-3">
                <h2 className="text-2xl font-babydoll font-bold text-[#1c1c1a]">Ya casi estás dentro</h2>
                <p className="text-xs text-[#595750] font-sans leading-relaxed mt-1">Estás a punto de abrir la puerta a <b>{modalidadSeleccionada.nombre}</b> ({modalidadSeleccionada.precio}).</p>
              </div>
              <form onSubmit={registrarYRedirigir} className="space-y-4 font-sans">
                <div>
                  <label className="block text-xs font-semibold text-[#1c1c1a] mb-1">Nombre completo *</label>
                  <input type="text" name="Nombre" required placeholder="Tu nombre o alias" className="w-full editorial-input px-3.5 py-3 text-xs" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-[#1c1c1a] mb-1">Correo electrónico *</label>
                  <input type="email" name="Email" required placeholder="hola@ejemplo.com" className="w-full editorial-input px-3.5 py-3 text-xs" />
                </div>
                <button type="submit" disabled={enviandoRegistro} className="w-full editorial-btn py-3 text-xs mt-3 flex items-center justify-center gap-2 shadow-md">
                  {enviandoRegistro ? 'Procesando...' : (<><span>Apúntame</span><i className="fa-solid fa-arrow-right text-xs"></i></>)}
                </button>
              </form>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (esModalidadCorreo && !esAdministradora) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 w-full py-8 bg-[#ffffee]">
        <div className="editorial-card max-w-sm w-full p-8 space-y-4 text-center">
          <h1 className="font-babydoll text-4xl text-[#1c1c1a] font-bold">gilda</h1>
          <p className="text-xs text-[#595750] font-sans leading-relaxed">Tu modalidad actual ({sesion.modalidad}) está registrada exclusivamente para correo y no incluye acceso web.</p>
          <button onClick={cerrarSesion} className="editorial-btn px-4 py-2 text-xs">Cerrar sesión</button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center pt-6 pb-28 px-4 sm:px-6 max-w-lg w-full mx-auto relative bg-[#ffffee]">
      {toastMsg && (
        <div className="fixed top-6 z-50 bg-[#1c1c1a] text-[#ffffee] text-xs px-4 py-2.5 rounded-full shadow-lg fade-in font-sans font-medium">
          {toastMsg}
        </div>
      )}

      {modalImportarAbierto && (
        <ModalImportarPin onClose={() => setModalImportarAbierto(false)} onSave={(url, tit) => guardarEnlaceExterna(objetoActivoParaImportar, url, tit)} />
      )}

      {mostrarModalUpgrade && <ModalUpgrade onClose={() => setMostrarModalUpgrade(false)} />}
      
      {mostrarModalShare && (
        <ModalCompartirStory 
          onClose={() => setMostrarModalShare(false)}
          usuario={nombreUsuarioPersonalizado || sesion.nombre}
          libro={libroActual}
          pagina={miPagina}
          citas={misCitas}
          decoracion={decoracionActual}
          misLibros={todosMisLibrosEstanteria}
          onPublicarCita={publicarCitaEnMuro}
        />
      )}

      {libroSeleccionadoDetalle && (
        <div className="fixed inset-0 z-[9999] bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 fade-in">
          <div className="editorial-card max-w-sm w-full p-6 space-y-4 text-center bg-white relative">
            <button onClick={() => { setLibroSeleccionadoDetalle(null); setMostrarInputCorreccionPortada(false); setEditandoPortadaUrl(''); }} className="absolute top-3 right-3 text-gray-400 hover:text-black">
              <i className="fa-solid fa-xmark text-sm"></i>
            </button>
            <div className="flex justify-center">
              <PortadaLibroEstable titulo={libroSeleccionadoDetalle.libro || libroSeleccionadoDetalle.titulo} autora={libroSeleccionadoDetalle.autora} portada={libroSeleccionadoDetalle.portada} size="large" />
            </div>
            <div className="space-y-1">
              <h3 className="font-babydoll text-xl font-bold">{libroSeleccionadoDetalle.libro || libroSeleccionadoDetalle.titulo}</h3>
              <p className="text-xs text-[#595750] italic font-sans">{libroSeleccionadoDetalle.autora || 'Autora desconocida'}</p>
              <p className="text-xs text-[#595750] uppercase tracking-wider pt-1 font-sans">Estado: <b>{libroSeleccionadoDetalle.estado || 'leyendo'}</b></p>
            </div>

            {mostrarInputCorreccionPortada ? (
              <div className="space-y-2 bg-[#faf9f5] p-3 rounded-xl border border-[#e6e4dc] font-sans">
                <input
                  type="text"
                  value={editandoPortadaUrl}
                  onChange={(e) => setEditandoPortadaUrl(e.target.value)}
                  placeholder="Pega la URL de la nueva portada..."
                  className="w-full px-3 py-2 text-xs border border-[#e6e4dc] rounded-lg bg-white text-[#1c1c1a] focus:outline-none focus:border-[#3d4220]"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      const tituloLibro = libroSeleccionadoDetalle.libro || libroSeleccionadoDetalle.titulo;
                      const nuevaPortada = editandoPortadaUrl.trim();

                      const clon = lecturasPersonales.map(l => {
                        if ((l.email || '').toLowerCase().trim() === (sesion.email || '').toLowerCase().trim() && (l.libro || l.titulo || '').toLowerCase().trim() === tituloLibro.toLowerCase().trim()) {
                          return { ...l, portada: nuevaPortada };
                        }
                        return l;
                      });
                      setLecturasPersonales(clon);
                      setLibroSeleccionadoDetalle({ ...libroSeleccionadoDetalle, portada: nuevaPortada });

                      enviarAccion('actualizar_portada_libro', {
                        email: sesion.email,
                        libro: tituloLibro,
                        portada: nuevaPortada
                      });

                      registrarActividadPresencia();
                      mostrarToast('¡Portada actualizada con éxito!');
                      setMostrarInputCorreccionPortada(false);
                    }}
                    className="flex-1 editorial-btn py-1.5 text-xs font-semibold"
                  >
                    Guardar
                  </button>
                  <button
                    onClick={() => setMostrarInputCorreccionPortada(false)}
                    className="flex-1 bg-white border border-[#e6e4dc] text-[#595750] py-1.5 rounded-xl text-xs font-semibold hover:bg-gray-50"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            ) : (
              <button onClick={() => { setEditandoPortadaUrl(libroSeleccionadoDetalle.portada || ''); setMostrarInputCorreccionPortada(true); }} className="w-full bg-[#faf9f5] border border-[#e6e4dc] text-[#3d4220] py-2 rounded-xl text-xs font-semibold">
                <i className="fa-solid fa-image mr-1"></i> Corregir portada o URL
              </button>
            )}

            <div className="py-3 px-3 my-2 bg-[#ffffee] rounded-xl border border-[#e6e4dc] flex flex-col items-center gap-2 font-sans">
              <span className="text-[11px] font-bold uppercase tracking-wider text-[#3d4220]">
                deja tu marca de tinta
              </span>
              
              <div className="flex gap-1.5 items-center">
                {[1, 2, 3, 4, 5].map((num) => (
                  <span 
                    key={num}
                    onClick={() => setEstrellasSeleccionadas(num)}
                    className={`cursor-pointer font-babydoll text-2xl transition-transform hover:scale-125 ${
                      num <= estrellasSeleccionadas ? 'text-[#1c1c1a]' : 'text-[#d4cfbc]'
                    }`}
                    title={`${num} de 5 estrellas`}
                  >
                    ✦
                  </span>
                ))}
              </div>

              <button 
                onClick={() => {
                  const tituloLibro = libroSeleccionadoDetalle.libro || libroSeleccionadoDetalle.titulo;
                  const portadaLibro = libroSeleccionadoDetalle.portada || '';
                  
                  enviarAccion('evaluar_libro', {
                    email: sesion.email,
                    nombre: nombreUsuarioPersonalizado || sesion.nombre,
                    libro: tituloLibro,
                    estrellas: estrellasSeleccionadas,
                    portada: portadaLibro,
                    timestamp: new Date().toLocaleString()
                  });

                  registrarActividadPresencia();
                  mostrarToast(`¡Marca de ${estrellasSeleccionadas}/5 ✦ guardada en el muro!`);
                  setLibroSeleccionadoDetalle(null);
                }} 
                className="w-full mt-2 editorial-btn py-2 text-xs font-semibold shadow-xs flex items-center justify-center gap-1.5"
              >
                <i className="fa-solid fa-feather text-[10px]"></i> Estampar en el Muro del Club
              </button>
            </div>

            <div className="pt-2 border-t border-[#e6e4dc] flex gap-2">
              <button onClick={() => {
                const tituloBuscado = (libroSeleccionadoDetalle.libro || libroSeleccionadoDetalle.titulo || '').trim().toLowerCase();
                const nombreOriginalLibro = libroSeleccionadoDetalle.libro || libroSeleccionadoDetalle.titulo;
                const clon = lecturasPersonales.filter(l => !( (l.email || '').toLowerCase().trim() === (sesion.email || '').toLowerCase().trim() && (l.libro || l.titulo || '').toLowerCase().trim() === tituloBuscado ));
                setLecturasPersonales(clon);
                enviarAccion('eliminar_libro_personal', { email: sesion.email, libro: nombreOriginalLibro });
                registrarActividadPresencia();
                setLibroSeleccionadoDetalle(null);
                mostrarToast('Libro eliminado de la estantería');
              }} className="flex-1 py-2 rounded-xl border border-red-200 text-red-600 text-xs font-bold">Eliminar</button>
              <button onClick={() => { setLibroSeleccionadoDetalle(null); setMostrarInputCorreccionPortada(false); }} className="flex-1 editorial-btn py-2 text-xs">Cerrar</button>
            </div>
          </div>
        </div>
      )}

      <header className="w-full mb-5 flex justify-between items-center bg-[#FFFFFF] text-[#1c1c1a] p-4 rounded-2xl border border-[#e6e4dc] shadow-sm">
        <div className="flex items-center gap-3 overflow-hidden">
          <AvatarUsuaria foto={fotoPerfilPersonalizada} nombre={nombreUsuarioPersonalizado || sesion.nombre} sizeClass="w-10 h-10" textClass="text-lg" editable={true} onFotoChange={handleFotoPerfilUpdate} />
          <div className="overflow-hidden">
            <h2 className="font-bold text-lg leading-none truncate font-babydoll">{nombreUsuarioPersonalizado || sesion.nombre}</h2>
            <span className="text-xs text-[#595750] uppercase font-sans tracking-wider">{sesion.modalidad}</span>
          </div>
        </div>
        <button onClick={cerrarSesion} className="text-[#595750] hover:text-black p-2"><i className="fa-solid fa-arrow-right-from-bracket"></i></button>
      </header>

      <main className="w-full flex-grow space-y-4">
        <div style={{ display: seccionApp === 'inicio' ? 'block' : 'none' }} className="space-y-4 fade-in">
          <div className="editorial-card p-5 space-y-4" onClick={registrarActividadPresencia}>
            <div className="flex justify-between items-center border-b border-[#e6e4dc] pb-2.5 mb-2">
               <h3 className="font-babydoll text-xl font-bold flex items-center gap-2 text-[#1c1c1a]">Progreso actual</h3>
               <button onClick={() => setMostrarModalShare(true)} className="text-xs font-bold font-sans flex items-center gap-1.5 text-[#3d4220] bg-white border border-[#e6e4dc] px-3 py-1.5 rounded-full shadow-sm hover:bg-[#faf9f5] transition-all"><i className="fa-brands fa-instagram text-[#3d4220]"></i> Compartir en Stories</button>
            </div>

            <div className="flex gap-4 items-center">
              <PortadaLibroEstable titulo={libroActual.titulo} autora={libroActual.autora} portada={libroActual.portada} size="large" />
              <div className="space-y-2 w-full">
                <span className="text-xs uppercase tracking-wider text-[#3d4220] font-bold font-sans">Lectura del club</span>
                <h2 className="font-babydoll text-2xl font-bold leading-tight">{libroActual.titulo}</h2>
                <p className="text-xs text-[#595750] italic font-sans">{libroActual.autora}</p>
                <div className="mt-2">
                  <div className="flex justify-between text-xs text-[#595750] mb-1 font-sans"><span>progreso</span><span>{porcentajeLibro}%</span></div>
                  <div className="w-full bg-[#faf9f5] rounded-full h-2 border border-[#e6e4dc]"><div className="bg-[#3d4220] h-full rounded-full" style={{width: `${porcentajeLibro}%`}}></div></div>
                </div>
              </div>
            </div>
            <div className="pt-3 border-t border-[#e6e4dc] flex items-center justify-between">
              <span className="text-xs text-[#595750] font-sans">página actual:</span>
              <div className="flex items-center gap-2">
                <input type="number" value={miPagina} onChange={(e) => setMiPagina(Number(e.target.value))} className="editorial-input w-16 text-center py-1.5 text-xs font-semibold" />
                <button onClick={() => { 
                  enviarAccion('actualizar_pagina', { pagina: miPagina }); 
                  registrarActividadPresencia();
                  setUsuariasClub(prev => prev.map(u => {
                    if ((u.email || '').trim().toLowerCase() === (sesion?.email || '').trim().toLowerCase()) return { ...u, pagina: miPagina };
                    return u;
                  }));
                  mostrarToast('Progreso actualizado'); 
                }} className="editorial-btn px-3.5 py-1.5 text-xs">ok</button>
              </div>
            </div>
          </div>

          <div className="editorial-card p-5 space-y-3">
            <h3 className="font-babydoll text-xl font-bold flex items-center gap-2 text-[#1c1c1a]">
              <i className="fa-solid fa-location-dot text-[#3d4220]"></i> Tu localización
            </h3>
            <p className="text-xs text-[#595750] font-sans italic">Añade tu ciudad y código postal para ubicarte en el mapa global del club.</p>
            <div className="grid grid-cols-2 gap-2 pt-1">
              <input type="text" placeholder="Ciudad..." value={miCiudadInput} onChange={(e) => setMiCiudadInput(e.target.value)} className="editorial-input p-2.5 text-xs" />
              <input type="text" placeholder="C. Postal..." value={miCodigoPostalInput} onChange={(e) => setMiCodigoPostalInput(e.target.value)} className="editorial-input p-2.5 text-xs" />
            </div>
            <button onClick={() => {
              safeSet('gilda_ciudad', miCiudadInput);
              safeSet('gilda_codigo_postal', miCodigoPostalInput);
              enviarAccion('actualizar_ubicacion', { ciudad: miCiudadInput, codigo_postal: miCodigoPostalInput });
              registrarActividadPresencia();
              setUsuariasClub(prev => prev.map(u => {
                if ((u.email || '').trim().toLowerCase() === (sesion?.email || '').trim().toLowerCase()) return { ...u, ciudad: miCiudadInput, provincia_region: miCiudadInput };
                return u;
              }));
              mostrarToast('Ubicación guardada correctamente');
            }} className="w-full editorial-btn py-2.5 text-xs font-semibold">Guardar ubicación</button>
          </div>

          <div className="editorial-card p-5 space-y-4">
            <div className="flex justify-between items-center border-b border-[#e6e4dc] pb-2">
              <h3 className="font-babydoll text-xl font-bold flex items-center gap-2">
                <i className="fa-regular fa-calendar-days text-[#3d4220]"></i> Calendario del club
              </h3>
              <span className="text-xs text-[#595750] font-sans uppercase">
                {eventosCalendario.filter(e => (e.estado || '').toLowerCase() !== 'pendiente' && (e.estado || '').toLowerCase() !== 'por definir').length} programado(s)
              </span>
            </div>
            <CalendarioInteractivo eventos={eventosCalendario} />
          </div>

          <div className="editorial-card p-4 space-y-3">
            <div className="flex justify-between items-center text-xs px-1">
              <span className="font-babydoll text-xl font-bold">Mapa global de lectoras</span>
              <span className="text-xs text-[#3d4220] font-bold font-sans">{usuariasClub.length} socia(s)</span>
            </div>
            <MapaGildaEstable usuarias={usuariasClub} />
          </div>
        </div>

        <div style={{ display: seccionApp === 'edificio' ? 'block' : 'none' }} className="w-full flex justify-center fade-in">
          <EdificioClub 
            usuarias={miembrosEdificio} 
            libroActual={libroActual} 
            sesionEmail={sesion.email}
            chatBloqueado={esRestringida}
            onAddWantToRead={(t, a, p) => guardarLibroPersonal(t, 0, 'want_to_read', a, p)} 
            onAbrirPrivado={(socia) => {
              if (esRestringida) {
                setMostrarModalUpgrade(true);
                return;
              }
              setSeccionApp('comunidad');
              setSubTabComunidad('chat');
              setChatModo('privado');
              setDestinatarioPrivado(socia);
            }}
          />
        </div>

        <div style={{ display: seccionApp === 'habitacion' ? 'block' : 'none' }} className="space-y-5 fade-in">
          <section className="rounded-2xl border border-[#d8cdb8] bg-[#f3eadb] p-5 sm:p-6 shadow-sm">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase text-[#6c5b42] font-sans">tu rincón de lectura</p>
                <h1 className="font-babydoll text-3xl sm:text-4xl font-bold text-[#232321] leading-tight">Mi habitación</h1>
                <p className="mt-1 text-xs text-[#6b6255] font-sans">Un espacio propio para tus libros y lecturas.</p>
              </div>
              <div className="flex flex-wrap gap-2 sm:justify-end">
                <button onClick={() => setMostrarModalShare(true)} className="px-3 py-2 text-xs rounded-xl font-bold font-sans bg-white/75 border border-[#d8cdb8] text-[#3d4220] shadow-sm hover:bg-white flex items-center gap-1.5 transition-colors">
                  <i className="fa-brands fa-instagram text-xs"></i> Compartir
                </button>
                <button onClick={() => { const nuevo = !isReadingNow; setIsReadingNow(nuevo); safeSet('gilda_is_reading', nuevo); enviarAccion('estado_lectura', { leyendo: nuevo }); registrarActividadPresencia(); }} aria-pressed={isReadingNow} className={`px-3 py-2 text-xs rounded-xl font-bold font-sans border transition-colors flex items-center gap-1.5 ${isReadingNow ? 'bg-[#3d4220] border-[#3d4220] text-white' : 'bg-white/75 border-[#d8cdb8] text-[#595750] hover:bg-white'}`}>
                  <i className={`fa-solid ${isReadingNow ? 'fa-book-open' : 'fa-book'} text-[10px]`}></i>
                  {isReadingNow ? 'Leyendo ahora' : 'En pausa'}
                </button>
              </div>
            </div>
            <div className="mt-5 grid grid-cols-3 border-t border-[#d8cdb8] pt-3">
              <div>
                <p className="text-[9px] uppercase text-[#756a58] font-sans">mis libros</p>
                <p className="font-babydoll text-lg font-bold text-[#232321]">{todosMisLibrosEstanteria.length}</p>
              </div>
              <div className="border-l border-[#d8cdb8] pl-3">
                <p className="text-[9px] uppercase text-[#756a58] font-sans">marcos</p>
                <p className="font-babydoll text-lg font-bold text-[#232321]">{objetosPersonalizados.length}</p>
              </div>
              <div className="border-l border-[#d8cdb8] pl-3">
                <p className="text-[9px] uppercase text-[#756a58] font-sans">página</p>
                <p className="font-babydoll text-lg font-bold text-[#232321]">{miPagina}</p>
              </div>
            </div>
          </section>

          <section className="editorial-card p-4 sm:p-5 flex items-center gap-4">
            <div className="w-16 h-24 shrink-0 overflow-hidden rounded shadow-sm border border-[#e6e4dc] bg-[#faf9f5]">
              <PortadaLibroEstable titulo={libroActual.titulo} autora={libroActual.autora} portada={libroActual.portada} size="story" />
            </div>
            <div className="min-w-0 flex-grow">
              <p className="text-[10px] uppercase font-bold text-[#6b684f] font-sans">lectura del club</p>
              <h2 className="font-babydoll text-lg font-bold text-[#232321] leading-snug line-clamp-2">{libroActual.titulo}</h2>
              <p className="text-xs text-[#595750] italic font-sans truncate">{libroActual.autora}</p>
              <div className="mt-2 flex items-center gap-2">
                <div className="h-1.5 flex-grow rounded-full bg-[#e6e4dc] overflow-hidden">
                  <div className="h-full rounded-full bg-[#3d4220]" style={{ width: `${porcentajeLibro}%` }}></div>
                </div>
                <span className="text-[10px] font-bold text-[#595750] font-sans">{porcentajeLibro}%</span>
              </div>
            </div>
            <div className="shrink-0 text-right pl-2 border-l border-[#e6e4dc]">
              <p className="text-[9px] uppercase text-[#756a58] font-sans">página</p>
              <p className="font-babydoll text-lg font-bold text-[#232321]">{miPagina}</p>
            </div>
          </section>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="editorial-card p-3 flex items-center gap-3">
              <AvatarUsuaria foto={fotoPerfilPersonalizada} nombre={nombreUsuarioPersonalizado || sesion.nombre} sizeClass="w-12 h-12" textClass="text-xl" editable={true} onFotoChange={handleFotoPerfilUpdate} />
              <div className="flex flex-col text-xs font-sans">
                <span className="font-bold text-[#1c1c1a]">Foto de perfil</span>
                <span className="text-xs text-[#595750]">Haz clic para subir imagen de tu galería</span>
              </div>
            </div>

            <div className="editorial-card p-3 flex flex-col justify-center gap-2">
              <label htmlFor="room-decoration" className="text-xs font-bold text-[#1c1c1a] font-sans">Ambiente de la balda</label>
              <select id="room-decoration" value={decoracionActual} onChange={(e) => { setDecoracionActual(e.target.value); safeSet('gilda_decoracion', e.target.value); registrarActividadPresencia(); }} className="editorial-input w-full text-xs px-2.5 py-2 bg-white font-sans font-semibold">
                <option value="monstera">Plantita Monstera</option>
                <option value="maceta">Maceta Cerámica</option>
                <option value="vela">Vela Aromática</option>
                <option value="cafe">Taza de Café</option>
                <option value="cactus">Pequeño Cactus</option>
                <option value="auriculares">Auriculares Crema</option>
                <option value="tocadiscos">Tocadiscos Vintage</option>
                <option value="camara">Cámara Analógica</option>
                <option value="lampara">Lámpara de Lectura</option>
                <option value="ninguna">Sin decoración</option>
              </select>
            </div>
            <div className="editorial-card p-3 flex flex-col justify-center gap-2">
              <div className="flex items-center gap-2">
                <i className="fa-solid fa-bell text-[#8b6040] text-sm"></i>
                <span className="text-xs font-bold text-[#1c1c1a] font-sans">Avisos del club</span>
              </div>
              <p className="text-[10px] leading-relaxed text-[#756a58] font-sans">
                {estadoNotificaciones === 'comprobando' ? 'Preparando notificaciones…' :
                  estadoNotificaciones === 'push-activadas' || estadoNotificaciones === 'nativas-activadas' ? 'Notificaciones activadas en este dispositivo.' :
                  estadoNotificaciones === 'permiso-concedido' ? 'Permiso concedido; falta configurar el servidor push.' :
                  estadoNotificaciones === 'denegadas' ? 'Permiso denegado en los ajustes del dispositivo.' :
                  estadoNotificaciones === 'no-compatible' ? 'Notificaciones no disponibles en este navegador.' :
                  estadoNotificaciones === 'error' ? 'No se pudo preparar el servicio de notificaciones.' :
                  'Recibe avisos cuando haya novedades del club.'}
              </p>
              <button
                type="button"
                onClick={activarNotificaciones}
                disabled={['comprobando', 'solicitando', 'push-activadas', 'nativas-activadas', 'permiso-concedido', 'no-compatible'].includes(estadoNotificaciones)}
                className="w-full px-2.5 py-2 text-[10px] rounded-lg font-bold font-sans border border-[#d8cdb8] bg-white text-[#3d4220] hover:bg-[#f3eadb] disabled:opacity-50"
              >
                {estadoNotificaciones === 'push-activadas' || estadoNotificaciones === 'nativas-activadas' ? 'Activadas' : 'Activar avisos'}
              </button>
            </div>
          </div>

          <section className="editorial-card p-4 sm:p-5 space-y-4">
            <div className="flex items-end justify-between gap-3 border-b border-[#e6e4dc] pb-2">
              <div>
                <p className="text-[9px] uppercase font-bold text-[#756a58] font-sans">colección personal</p>
                <h2 className="font-babydoll text-xl font-bold text-[#232321]">Estantería</h2>
              </div>
              <span className="text-[10px] font-bold text-[#595750] font-sans text-right">{todosMisLibrosEstanteria.length} libros · {objetosPersonalizados.length} marcos</span>
            </div>

            <div className="pt-4 pb-6 px-3 estanteria-madera min-h-[225px] flex items-end justify-between overflow-x-auto">
              <div className="flex items-end justify-start gap-3.5 flex-grow">
                {todosMisLibrosEstanteria.length === 0 && objetosPersonalizados.length === 0 ? (
                  <div className="w-full text-center py-10"><p className="text-xs text-[#7A7565] italic font-sans">Aún no hay libros ni marcos en tu estantería...</p></div>
                ) : (
                  <>
                    {todosMisLibrosEstanteria.map((item, idx) => (
                      <LomoLibroEstanteria key={idx} item={item} onClick={() => setLibroSeleccionadoDetalle(item)} />
                    ))}
                    {objetosPersonalizados.map(obj => (
                      <ObjetoExternoEnmarcado key={obj.id} urlImagen={obj.url} titulo={obj.titulo} onClick={() => manejarClickEnMarco(obj.id)} />
                    ))}
                    <button onClick={agregarNuevoMarco} className="shrink-0 border-[1.5px] border-dashed border-[#1c1c1a] rounded-sm bg-[#f7f3e8]/60 hover:bg-[#f7f3e8] w-12 h-20 flex flex-col items-center justify-center text-[#595750] text-[10px] transition font-sans" title="Añadir marco">
                      <i className="fa-solid fa-plus text-xs mb-1"></i>
                      <span>Marco</span>
                    </button>
                  </>
                )}
              </div>
              {decoracionActual !== 'ninguna' && (
                <div className="shrink-0 pl-3 pb-1 flex items-end select-none">
                  <IlustracionDecoracion tipo={decoracionActual} onInteractuar={handleInteractuarIlustracion} />
                </div>
              )}
            </div>

            <div className="pt-4 border-t border-[#e6e4dc] space-y-3">
              <div className="flex bg-[#faf9f5] p-1 rounded-xl text-xs font-semibold text-center border border-[#e6e4dc] font-sans">
                <button onClick={() => setTabEstanteria('leyendo')} className={`flex-1 py-1.5 rounded-lg ${tabEstanteria === 'leyendo' ? 'bg-[#1c1c1a] text-[#ffffee]' : 'text-[#595750]'}`}>Leyendo</button>
                <button onClick={() => setTabEstanteria('want_to_read')} className={`flex-1 py-1.5 rounded-lg ${tabEstanteria === 'want_to_read' ? 'bg-[#1c1c1a] text-[#ffffee]' : 'text-[#595750]'}`}>Quiero leer</button>
                <button onClick={() => setTabEstanteria('leidos')} className={`flex-1 py-1.5 rounded-lg ${tabEstanteria === 'leidos' ? 'bg-[#1c1c1a] text-[#ffffee]' : 'text-[#595750]'}`}>Leídos</button>
              </div>

              {modoCreacionManual ? (
                <form onSubmit={(e) => {
                  e.preventDefault();
                  if (!manualTitulo.trim()) return;
                  guardarLibroPersonal(manualTitulo, 0, tabEstanteria, manualAutora, manualPortada);
                  setManualTitulo(''); setManualAutora(''); setManualPortada('');
                }} className="space-y-2 bg-[#ffffee] p-3 rounded-xl border border-[#e6e4dc]">
                  <p className="text-xs font-bold font-sans text-[#3d4220]">Añadir libro manualmente:</p>
                  <input type="text" placeholder="Título..." value={manualTitulo} onChange={(e) => setManualTitulo(e.target.value)} required className="w-full editorial-input p-2.5 text-xs" />
                  <input type="text" placeholder="Autora..." value={manualAutora} onChange={(e) => setManualAutora(e.target.value)} className="w-full editorial-input p-2.5 text-xs" />
                  <input type="text" placeholder="URL portada..." value={manualPortada} onChange={(e) => setManualPortada(e.target.value)} className="w-full editorial-input p-2.5 text-xs" />
                  {tabEstanteria === 'leyendo' && <input type="number" placeholder="Página actual..." value={paginaPersonalInput} onChange={(e) => setPaginaPersonalInput(e.target.value)} className="w-full editorial-input p-2.5 text-xs" />}
                  <div className="flex gap-2 pt-1">
                    <button type="submit" className="flex-1 editorial-btn py-2 text-xs">Guardar libro</button>
                    <button type="button" onClick={() => setModoCreacionManual(false)} className="flex-1 bg-white border border-[#e6e4dc] py-2 rounded-xl text-xs">Cancelar</button>
                  </div>
                </form>
              ) : (
                <div className="space-y-2 bg-[#ffffee] p-3 rounded-xl border border-[#e6e4dc]">
                  <BuscadorLibrosEstable placeholder="Buscar libro..." valor={libroPersonal} setValor={setLibroPersonal} onSelectLibro={(l) => { setLibroPersonal(l.titulo); guardarLibroPersonal(l.titulo, 0, tabEstanteria, l.autora, l.portada); }} />
                  <div className="flex justify-between items-center pt-1 font-sans">
                    <span className="text-xs text-[#595750]">¿No aparece?</span>
                    <button type="button" onClick={() => setModoCreacionManual(true)} className="text-xs text-[#3d4220] font-bold hover:underline">+ Crear manualmente</button>
                  </div>
                </div>
              )}
            </div>

            <div className="pt-3 border-t border-[#e6e4dc] space-y-2.5">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="font-babydoll text-base font-bold text-[#232321]">Tu biblioteca</h3>
                <span className="text-[10px] font-bold text-[#756a58] font-sans">{librosBibliotecaVisibles.length} {librosBibliotecaVisibles.length === 1 ? 'libro' : 'libros'}</span>
              </div>
              {librosBibliotecaVisibles.length === 0 ? (
                <p className="py-2 text-xs text-[#756a58] italic font-sans">Todavía no hay libros en esta lista.</p>
              ) : (
                <div className="divide-y divide-[#e6e4dc]">
                  {librosBibliotecaVisibles.map((item, idx) => (
                    <button
                      key={`${item.email || sesion.email}-${item.libro || item.titulo}-${idx}`}
                      type="button"
                      onClick={() => setLibroSeleccionadoDetalle(item)}
                      className="w-full flex items-center gap-3 py-2.5 text-left hover:bg-[#faf9f5] transition-colors"
                    >
                      <PortadaLibroEstable titulo={item.libro || item.titulo} autora={item.autora} portada={item.portada} size="thumb" />
                      <span className="min-w-0 flex-grow">
                        <span className="block truncate font-babydoll text-sm font-bold text-[#232321]">{item.libro || item.titulo}</span>
                        <span className="block truncate text-[10px] italic text-[#756a58] font-sans">{item.autora || 'Autora no especificada'}</span>
                      </span>
                      <span className="shrink-0 text-right text-[10px] font-sans text-[#595750]">
                        <span className="block">pág. {item.pagina || item.paginas || 0}</span>
                        <span className="block capitalize">{item.estado || 'leyendo'}</span>
                      </span>
                      <i className="fa-solid fa-chevron-right text-[9px] text-[#a59b88]"></i>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>

        <div style={{ display: seccionApp === 'capitulos' ? 'block' : 'none' }} className="space-y-4 fade-in">
          {capitulos.map((cap, i) => {
            if (['oculto', 'borrador'].includes(String(cap.estado || '').toLowerCase())) return null;
            const paginaMinima = Number(cap.pagina_fin || cap.pagina_bloqueo || cap.pagina || cap.paginaminima || 0);
            const desbloqueado = miPagina >= paginaMinima;
            const identificadorCap = String(cap.id || cap.titulo || '').trim().toLowerCase();
            const comentariosCapitulo = comentarios.filter(c => {
              const cCap = String(c.capitulo || '').trim().toLowerCase();
              const padreId = String(c.parent_id || '').trim();
              const esPrincipal = !padreId || padreId === '' || padreId === 'undefined';
              const coincide = !cCap || cCap === identificadorCap || cCap.includes(String(i + 1));
              return coincide && esPrincipal;
            });

            return (
              <div key={i} className="editorial-card p-5 space-y-4" onClick={registrarActividadPresencia}>
                <div className="flex justify-between items-center">
                  <h3 className="font-babydoll text-2xl font-bold">{cap.titulo}</h3>
                  <span className="text-xs text-[#595750] font-sans font-semibold">pág. {paginaMinima}</span>
                </div>
                {desbloqueado ? (
                  <div className="space-y-4">
                    <p className="text-sm text-gray-800 leading-relaxed whitespace-pre-line font-sans text-left">{cap.descripcion || cap.contenido}</p>
                    <div className="pt-4 border-t border-[#e6e4dc] space-y-3">
                      <h4 className="font-babydoll text-base font-bold">Comentarios de lectoras</h4>
                      <div className="space-y-3">
                        {comentariosCapitulo.length === 0 ? (
                          <p className="text-xs text-[#595750] italic font-sans">Aún no hay comentarios. ¡Sé la primera!</p>
                        ) : (
                          comentariosCapitulo.map((com, cIdx) => {
                            const idComentario = String(com.id || '').trim();
                            const respuestasCom = comentarios.filter(r => String(r.parent_id || '').trim() === idComentario);
                            const nombreAutorComentario = obtenerNombreReal(com.autora, com.autora);

                            return (
                              <div key={cIdx} className="bg-[#ffffee] p-3 rounded-xl border border-[#e6e4dc] text-xs space-y-2">
                                <div className="flex justify-between items-center">
                                  <span className="font-bold font-sans text-[#3d4220]">{nombreAutorComentario}</span>
                                  <span className="text-[10px] text-[#595750]">{com.fecha || ''}</span>
                                </div>
                                <p className="text-xs sm:text-sm text-gray-800 leading-relaxed font-sans text-left">{com.texto || ''}</p>
                                {!modalidadLimpia.includes('cotilla') && (
                                  <div className="flex justify-end">
                                    <button onClick={() => setRespondiendoA(respondiendoA === idComentario ? null : idComentario)} className="text-xs text-[#3d4220] font-bold hover:underline">
                                      {respondiendoA === idComentario ? 'Cancelar' : 'Responder'}
                                    </button>
                                  </div>
                                )}
                                {respuestasCom.length > 0 && (
                                  <div className="pl-3 mt-2 border-l-2 border-[#d4cfbc] space-y-2">
                                    {respuestasCom.map((resp, rIdx) => (
                                      <div key={rIdx} className="bg-white p-2 rounded-lg border border-[#e6e4dc] text-xs space-y-1">
                                        <div className="flex justify-between items-center">
                                          <span className="font-bold text-[#3d4220]">{obtenerNombreReal(resp.autora, resp.autora)}</span>
                                          <span className="text-[10px] text-[#595750]">{resp.fecha || ''}</span>
                                        </div>
                                        <p className="text-xs sm:text-sm text-gray-800 leading-relaxed font-sans text-left">{resp.texto || ''}</p>
                                      </div>
                                    ))}
                                  </div>
                                )}
                                {respondiendoA === idComentario && !modalidadLimpia.includes('cotilla') && (
                                  <form onSubmit={(e) => {
                                    e.preventDefault();
                                    const txtResp = textoRespuesta[idComentario];
                                    if (!txtResp || !txtResp.trim()) return;
                                    const nuevaRespObj = { capitulo: identificadorCap, parent_id: idComentario, autora: nombreUsuarioPersonalizado || sesion.nombre, texto: txtResp, fecha: 'Justo ahora' };
                                    setComentarios([...comentarios, nuevaRespObj]);
                                    enviarAccion('comentar_capitulo', { capitulo: identificadorCap, parent_id: idComentario, comentario: txtResp });
                                    registrarActividadPresencia();
                                    setTextoRespuesta({ ...textoRespuesta, [idComentario]: '' });
                                    setRespondiendoA(null);
                                    mostrarToast('Respuesta enviada');
                                  }} className="flex gap-2 pt-2">
                                    <input type="text" placeholder="Responde..." value={textoRespuesta[idComentario] || ''} onChange={(e) => setTextoRespuesta({ ...textoRespuesta, [idComentario]: e.target.value })} className="flex-grow editorial-input px-2.5 py-1.5 text-xs bg-white" />
                                    <button type="submit" className="editorial-btn px-2.5 py-1 text-xs">Enviar</button>
                                  </form>
                                )}
                              </div>
                            );
                          })
                        )}
                      </div>

                      {!modalidadLimpia.includes('cotilla') && (
                        <form onSubmit={(e) => {
                          e.preventDefault();
                          const clave = cap.id || cap.titulo;
                          const txt = textoComentario[clave];
                          if (!txt || !txt.trim()) return;
                          const nuevoCom = { capitulo: identificadorCap, parent_id: '', autora: nombreUsuarioPersonalizado || sesion.nombre, texto: txt, fecha: 'Justo ahora' };
                          setComentarios([...comentarios, nuevoCom]);
                          enviarAccion('comentar_capitulo', { capitulo: identificadorCap, comentario: txt });
                          registrarActividadPresencia();
                          setTextoComentario({ ...textoComentario, [clave]: '' });
                          mostrarToast('Comentario enviado');
                        }} className="flex gap-2 pt-1">
                          <input type="text" placeholder="Escribe tu reflexión..." value={textoComentario[cap.id || cap.titulo] || ''} onChange={(e) => setTextoComentario({ ...textoComentario, [cap.id || cap.titulo]: e.target.value })} className="flex-grow editorial-input px-3 py-2 text-xs" />
                          <button type="submit" className="editorial-btn px-3 text-xs">Comentar</button>
                        </form>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="p-4 bg-[#ffffee] border border-[#e6e4dc] rounded-xl text-center space-y-2">
                    <i className="fa-solid fa-lock text-[#595750] text-sm"></i>
                    <p className="text-xs text-[#595750] font-sans">Capítulo bloqueado. Necesitas llegar a la página <b>{paginaMinima}</b> (vas por la {miPagina}).</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div style={{ display: seccionApp === 'muro' ? 'block' : 'none' }} className="space-y-4 fade-in">
          <div className="editorial-card p-5 space-y-4">
            <div className="border-b border-[#e6e4dc] pb-2">
              <h3 className="font-babydoll text-2xl font-bold text-[#1c1c1a]">el muro del club</h3>
              <p className="text-xs text-[#595750] font-sans italic">el rastro de tinta y lecturas compartidas de todas las socias</p>
            </div>

            <div className="space-y-3">
              {muroActividad.length === 0 ? (
                <p className="text-xs text-[#595750] italic font-sans text-center py-6">Aún no hay marcas de tinta en el muro. ¡Sé la primera en puntuar un libro!</p>
              ) : (
                muroActividad.slice().reverse().map((item, idx) => {
                  const esCita = item.tipo === 'cita' || Boolean(item.cita);
                  const numEstrellas = Number(item.estrellas) || 5;
                  const estrellasTexto = '✦'.repeat(numEstrellas) + '✧'.repeat(5 - numEstrellas);

                  return (
                    <div key={idx} className="bg-[#ffffee] p-3.5 rounded-xl border border-[#e6e4dc] flex gap-3 items-center shadow-xs">
                      <PortadaLibroEstable titulo={item.libro} portada={item.portada} size="thumb" />
                      <div className="flex flex-col justify-between w-full space-y-1">
                        <div className="flex justify-between items-center">
                          <span className="font-bold font-sans text-xs text-[#3d4220]">{item.nombre || 'Socia'}</span>
                          <span className="text-[10px] text-[#595750] font-sans">{item.timestamp}</span>
                        </div>
                        {esCita ? (
                          <>
                            <p className="text-[10px] text-[#6b684f] font-sans">Ha compartido una cita de <b>{item.libro || 'su lectura'}</b>:</p>
                            <blockquote className="border-l-2 border-[#8b6040] pl-2.5 font-babydoll text-sm leading-relaxed text-[#232321]">“{item.cita || item.libro}”</blockquote>
                          </>
                        ) : (
                          <>
                            <p className="text-xs text-[#1c1c1a] font-sans leading-relaxed">Ha dejado su marca en <b>{item.libro}</b>:</p>
                            <span className="font-babydoll text-base tracking-widest text-[#1c1c1a]">{estrellasTexto} ({numEstrellas}/5)</span>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        <div style={{ display: seccionApp === 'comunidad' && !esRestringida ? 'block' : 'none' }} aria-hidden={esRestringida || seccionApp !== 'comunidad'} className="space-y-4 fade-in" onClick={registrarActividadPresencia}>
          <div className="flex bg-[#faf9f5] p-1 rounded-xl text-xs font-bold text-center border border-[#e6e4dc] font-sans">
            <button onClick={() => setSubTabComunidad('chat')} className={`flex-1 py-1.5 rounded-lg ${subTabComunidad === 'chat' ? 'bg-[#1c1c1a] text-[#ffffee]' : 'text-[#595750]'}`}>Chat</button>
            <button onClick={() => setSubTabComunidad('mapa')} className={`flex-1 py-1.5 rounded-lg ${subTabComunidad === 'mapa' ? 'bg-[#1c1c1a] text-[#ffffee]' : 'text-[#595750]'}`}>Mapa ({usuariasClub.length})</button>
            <button onClick={() => setSubTabComunidad('archivo')} className={`flex-1 py-1.5 rounded-lg ${subTabComunidad === 'archivo' ? 'bg-[#1c1c1a] text-[#ffffee]' : 'text-[#595750]'}`}>Archivo</button>
            <button onClick={() => setSubTabComunidad('cafecitos')} className={`flex-1 py-1.5 rounded-lg ${subTabComunidad === 'cafecitos' ? 'bg-[#1c1c1a] text-[#ffffee]' : 'text-[#595750]'}`}>Cafecitos</button>
            <button onClick={() => setSubTabComunidad('buzon')} className={`flex-1 py-1.5 rounded-lg ${subTabComunidad === 'buzon' ? 'bg-[#1c1c1a] text-[#ffffee]' : 'text-[#595750]'}`}>Buzón</button>
          </div>

          {subTabComunidad === 'chat' && (
            <div className="editorial-card h-[520px] flex flex-col justify-between relative overflow-hidden bg-[#faf9f5]">
              <div className="bg-[#FFFFFF] p-3 border-b border-[#e6e4dc] flex flex-col gap-1 rounded-t-2xl shadow-xs">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-babydoll text-lg font-bold text-[#1c1c1a] leading-none">Chat de Lectoras</h3>
                    <div className="flex items-center gap-1.5 mt-1">
                      <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
                      <p className="text-[10px] font-sans font-medium text-[#595750]">
                        {cantidadSociasEnLinea} {cantidadSociasEnLinea === 1 ? 'socia en línea' : 'socias en línea'}
                      </p>
                    </div>
                  </div>
                  
                  <div className="flex bg-[#f5f2e6] p-0.5 rounded-lg border border-[#e6e4dc]">
                    <button onClick={() => { setChatModo('global'); setDestinatarioPrivado(null); }} className={`px-2.5 py-1 rounded-md text-[10px] font-bold transition-all ${chatModo === 'global' ? 'bg-white text-[#1c1c1a] shadow-xs' : 'text-[#595750]'}`}>Global</button>
                    <button onClick={() => setChatModo('privado')} className={`px-2.5 py-1 rounded-md text-[10px] font-bold transition-all ${chatModo === 'privado' ? 'bg-white text-[#1c1c1a] shadow-xs' : 'text-[#595750]'}`}>Privados</button>
                  </div>
                </div>
              </div>

              {chatModo === 'global' && (
                <>
                  <div className="flex-grow p-4 overflow-y-auto space-y-3 flex flex-col bg-[#faf9f5]/50">
                    {chatMsgs.filter(m => !m.tipo || m.tipo !== 'privado').map((m, i) => {
                      const nombreAutorChat = obtenerNombreReal(m.email, m.usuario || m.usuaria);
                      const usuarioMsg = nombreAutorChat.toLowerCase().trim();
                      const miNombre = (nombreUsuarioPersonalizado || sesion.nombre || '').toLowerCase().trim();
                      const esMia = usuarioMsg === miNombre || (m.email && m.email.toLowerCase() === sesion.email.toLowerCase());
                      
                      const horaMensaje = formatearHoraWhatsApp(m.timestamp, m.fecha);

                      return (
                        <div key={i} className={`flex flex-col max-w-[82%] ${esMia ? 'self-end items-end' : 'self-start items-start'}`}>
                          {!esMia && <span className="text-[10px] font-bold text-[#3d4220] font-sans mb-0.5 px-1">{nombreAutorChat}</span>}
                          <div className={`px-3.5 py-2.5 text-xs leading-relaxed font-sans relative shadow-xs ${esMia ? 'bg-[#3d4220] text-white rounded-[18px] rounded-br-[4px]' : 'bg-white border border-[#e6e4dc] text-[#1c1c1a] rounded-[18px] rounded-bl-[4px]'}`}>
                            <span className="block pr-8 pb-1">{m.mensaje}</span>
                            <span className={`absolute bottom-1 right-2.5 text-[8.5px] font-sans ${esMia ? 'text-white/70' : 'text-[#595750]'}`}>
                              {horaMensaje}
                            </span>
                          </div>
                        </div>
                      );
                    })}

                    {sociaEscribiendo && (
                      <div className="self-start text-[11px] font-sans italic text-[#3d4220] bg-white border border-[#e6e4dc] px-3 py-1.5 rounded-full shadow-xs fade-in flex items-center gap-2">
                        <i className="fa-solid fa-pen-nib animate-bounce text-[10px]"></i>
                        <span><b>{sociaEscribiendo}</b> está escribiendo...</span>
                      </div>
                    )}

                    <div ref={chatEndRef} />
                  </div>

                  <form onSubmit={(e) => { 
                    e.preventDefault(); 
                    if(!nuevoChat.trim()) return; 
                    enviarAccion('enviar_chat', { mensaje: nuevoChat, tipo: 'global' }); 
                    registrarActividadPresencia();
                    setChatMsgs(prev => [...prev, { email: sesion.email, usuario: nombreUsuarioPersonalizado || sesion.nombre, mensaje: nuevoChat, tipo: 'global', fecha: 'Justo ahora', timestamp: new Date().toISOString() }]);
                    setNuevoChat(''); 
                  }} className="p-3 border-t border-[#e6e4dc] flex gap-2 bg-white">
                    <input 
                      type="text" 
                      value={nuevoChat} 
                      onChange={e => {
                        setNuevoChat(e.target.value);
                        manejarTipeoChat(e.target.value);
                      }} 
                      className="flex-grow editorial-input px-3.5 py-2.5 text-xs" 
                      placeholder="Escribe un mensaje al club..." 
                    />
                    <button type="submit" className="editorial-btn px-4 py-2.5 text-xs shadow-sm"><i className="fa-solid fa-paper-plane"></i></button>
                  </form>
                </>
              )}

              {chatModo === 'privado' && !destinatarioPrivado && (
                <div className="flex-grow p-4 overflow-y-auto space-y-2 bg-[#faf9f5]">
                  <p className="text-xs text-[#595750] font-sans italic pb-2">Selecciona una socia para abrir una conversación privada:</p>
                  {usuariasClub.filter(u => (u.email || '').toLowerCase().trim() !== (sesion.email || '').toLowerCase().trim()).map((socia, sIdx) => {
                    const nombreSociaReal = socia.nombre || socia.email.split('@')[0];
                    return (
                      <div key={sIdx} onClick={() => setDestinatarioPrivado(socia)} className="flex items-center justify-between p-3 bg-white rounded-xl border border-[#e6e4dc] cursor-pointer hover:bg-[#faf9f5] transition-all shadow-xs">
                        <div className="flex items-center gap-3 overflow-hidden">
                          <AvatarUsuaria foto={socia.foto_perfil} nombre={nombreSociaReal} sizeClass="w-8 h-8" textClass="text-xs" />
                          <div className="overflow-hidden">
                            <div className="flex items-center gap-1.5">
                              <IndicadorPresencia timestamp={socia.ultima_conexion} />
                              <p className="font-babydoll font-bold text-sm truncate text-[#1c1c1a]">{nombreSociaReal}</p>
                            </div>
                            <p className="text-xs text-[#595750] truncate font-sans font-medium">{socia.modalidad || 'socia de gilda'}</p>
                          </div>
                        </div>
                        <span className="text-xs text-[#3d4220] font-bold bg-[#ffffee] px-3 py-1.5 rounded-xl border border-[#e6e4dc] shadow-xs flex items-center gap-1">
                          <i className="fa-solid fa-envelope text-xs"></i> Chat
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              {chatModo === 'privado' && destinatarioPrivado && (
                <>
                  <div className="bg-[#FFFFFF] p-2.5 border-b border-[#e6e4dc] flex items-center justify-between text-xs shadow-xs">
                    <button onClick={() => setDestinatarioPrivado(null)} className="text-[#3d4220] font-bold flex items-center gap-1">
                      <i className="fa-solid fa-arrow-left"></i> Volver
                    </button>
                    <div className="flex items-center gap-1.5">
                      <IndicadorPresencia timestamp={destinatarioPrivado.ultima_conexion} />
                      <span className="font-babydoll font-bold text-sm">{destinatarioPrivado.nombre || destinatarioPrivado.email}</span>
                    </div>
                  </div>
                  
                  <div className="flex-grow p-4 overflow-y-auto space-y-3 flex flex-col bg-[#faf9f5]/50">
                    {chatMsgs.filter(m => {
                      if (m.tipo !== 'privado') return false;
                      const rem = (m.remitente || m.email || '').toLowerCase().trim();
                      const dest = (m.destinatario || '').toLowerCase().trim();
                      const miEmail = (sesion.email || '').toLowerCase().trim();
                      const otroEmail = (destinatarioPrivado.email || '').toLowerCase().trim();
                      return (rem === miEmail && dest === otroEmail) || (rem === otroEmail && dest === miEmail);
                    }).map((m, i) => {
                      const miEmail = (sesion.email || '').toLowerCase().trim();
                      const rem = (m.remitente || m.email || '').toLowerCase().trim();
                      const esMia = rem === miEmail;

                      const horaMensaje = formatearHoraWhatsApp(m.timestamp, m.fecha);

                      return (
                        <div key={i} className={`flex flex-col max-w-[82%] ${esMia ? 'self-end items-end' : 'self-start items-start'}`}>
                          <div className={`px-3.5 py-2.5 text-xs leading-relaxed font-sans relative shadow-xs ${esMia ? 'bg-[#3d4220] text-white rounded-[18px] rounded-br-[4px]' : 'bg-white border border-[#e6e4dc] text-[#1c1c1a] rounded-[18px] rounded-bl-[4px]'}`}>
                            <span className="block pr-8 pb-1">{m.mensaje}</span>
                            <span className={`absolute bottom-1 right-2.5 text-[8.5px] font-sans ${esMia ? 'text-white/70' : 'text-[#595750]'}`}>
                              {horaMensaje}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                    <div ref={chatEndRef} />
                  </div>

                  <form onSubmit={(e) => {
                    e.preventDefault();
                    if (!nuevoChatPrivado.trim()) return;
                    const payload = {
                      tipo: 'privado',
                      remitente: sesion.email,
                      destinatario: destinatarioPrivado.email,
                      mensaje: nuevoChatPrivado
                    };
                    enviarAccion('enviar_chat', payload);
                    registrarActividadPresencia();
                    setChatMsgs(prev => [...prev, {
                      email: sesion.email,
                      remitente: sesion.email,
                      destinatario: destinatarioPrivado.email,
                      mensaje: nuevoChatPrivado,
                      tipo: 'privado',
                      fecha: 'Justo ahora',
                      timestamp: new Date().toISOString()
                    }]);
                    setNuevoChatPrivado('');
                  }} className="p-3 border-t border-[#e6e4dc] flex gap-2 bg-white">
                    <input 
                      type="text" 
                      value={nuevoChatPrivado} 
                      onChange={e => {
                        setNuevoChatPrivado(e.target.value);
                        manejarTipeoChat(e.target.value);
                      }} 
                      className="flex-grow editorial-input px-3.5 py-2.5 text-xs" 
                      placeholder={`Escribe a ${destinatarioPrivado.nombre || 'socia'}...`} 
                    />
                    <button type="submit" className="editorial-btn px-4 py-2.5 text-xs"><i className="fa-solid fa-paper-plane"></i></button>
                  </form>
                </>
              )}
            </div>
          )}

          {subTabComunidad === 'mapa' && (
            <div className="editorial-card p-4 space-y-3">
              <div className="flex justify-between items-center text-xs px-1">
                <span className="font-babydoll text-xl font-bold">Mapa global de lectoras</span>
                <span className="text-xs text-[#3d4220] font-bold font-sans">{usuariasClub.length} socia(s)</span>
              </div>
              <MapaGildaEstable usuarias={usuariasClub} />
            </div>
          )}

          {subTabComunidad === 'cafecitos' && (
            <div className="space-y-3">
              <header className="px-1">
                <p className="text-[10px] uppercase font-bold text-[#756a58] font-sans">encuentros del club</p>
                <h2 className="font-babydoll text-2xl font-bold text-[#232321]">Votación de cafecitos</h2>
                <p className="text-xs text-[#595750] font-sans">Elige las fechas que te gustaría compartir con la comunidad.</p>
              </header>

              {cafecitosConVotos.length === 0 ? (
                <div className="editorial-card p-6 text-center">
                  <i className="fa-solid fa-mug-hot text-xl text-[#8b6040]"></i>
                  <p className="mt-2 text-xs text-[#595750] font-sans">Todavía no hay propuestas de cafecitos activas.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {cafecitosConVotos.map(cafecito => (
                    <article key={cafecito.fecha || cafecito.titulo} className="editorial-card p-4 space-y-3">
                      <div className="flex items-start gap-3">
                        <div className="w-9 h-9 shrink-0 rounded-full bg-[#f3eadb] border border-[#e6e4dc] flex items-center justify-center text-[#805a3b]">
                          <i className="fa-solid fa-mug-hot text-sm"></i>
                        </div>
                        <div className="min-w-0 flex-grow">
                          <h3 className="font-babydoll text-lg font-bold leading-snug text-[#232321]">{cafecito.titulo || 'Cafecito del club'}</h3>
                          {cafecito.fecha && <p className="text-[10px] uppercase font-bold text-[#6b684f] font-sans">{cafecito.fecha}</p>}
                          {cafecito.descripcion && <p className="mt-1 text-xs leading-relaxed text-[#595750] font-sans">{cafecito.descripcion}</p>}
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <div className="flex justify-between items-center text-[10px] text-[#595750] font-sans">
                          <span>{cafecito.votos} {cafecito.votos === 1 ? 'voto' : 'votos'}</span>
                          <span>{cafecito.porcentaje}%</span>
                        </div>
                        <div className="h-1.5 rounded-full bg-[#e6e4dc] overflow-hidden">
                          <div className="h-full rounded-full bg-[#8b6040] transition-all duration-300" style={{ width: `${cafecito.porcentaje}%` }}></div>
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={!cafecito.fecha}
                        aria-pressed={cafecito.yaVoto}
                        onClick={() => votarCafecito(cafecito)}
                        className={`w-full py-2 rounded-xl text-xs font-bold font-sans border transition-colors disabled:opacity-50 ${cafecito.yaVoto ? 'bg-[#f3eadb] text-[#6f4e37] border-[#d8cdb8]' : 'bg-white text-[#3d4220] border-[#e6e4dc] hover:bg-[#faf9f5]'}`}
                      >
                        <i className={`fa-solid ${cafecito.yaVoto ? 'fa-check' : 'fa-heart'} mr-1.5`}></i>
                        {cafecito.yaVoto ? 'Retirar mi voto' : 'Votar este cafecito'}
                      </button>
                    </article>
                  ))}
                </div>
              )}
            </div>
          )}

          {subTabComunidad === 'archivo' && (
            <div className="space-y-4">
              <div className="editorial-card p-5 space-y-3">
                <h3 className="font-babydoll text-xl font-bold">Proponer nueva lectura</h3>
                <form onSubmit={(e) => {
                  e.preventDefault();
                  const tit = nuevaPropuestaTitulo?.trim();
                  if (!tit) return;
                  const nueva = { titulo: tit, autora: nuevaPropuestaAutora?.trim() || '', votos: '1', votantes: sesion.email.toLowerCase(), portada: nuevaPropuestaPortada?.trim() || '' };
                  setPropuestas([...propuestas, nueva]);
                  enviarAccion('propuesta', nueva);
                  registrarActividadPresencia();
                  setNuevaPropuestaTitulo(''); setNuevaPropuestaAutora(''); setNuevaPropuestaPortada('');
                  mostrarToast('Propuesta añadida.');
                }} className="space-y-2">
                  <BuscadorLibrosEstable placeholder="Título del libro o autora..." valor={nuevaPropuestaTitulo} setValor={setNuevaPropuestaTitulo} onSelectLibro={(l) => { setNuevaPropuestaTitulo(l.titulo); setNuevaPropuestaAutora(l.autora); setNuevaPropuestaPortada(l.portada); }} />
                  <input type="text" placeholder="Autora..." value={nuevaPropuestaAutora || ''} onChange={e=>setNuevaPropuestaAutora(e.target.value)} className="w-full editorial-input p-2.5 text-xs" />
                  <button type="submit" className="w-full editorial-btn py-2.5 text-xs">Añadir propuesta</button>
                </form>
              </div>

              <div className="editorial-card p-5">
                <div className="flex justify-between items-center mb-3">
                  <h3 className="font-babydoll text-xl font-bold">Votación del mes</h3>
                  <span className="text-xs text-[#595750] font-sans uppercase">Propuestas del club</span>
                </div>

                {(() => {
                  const diaActual = new Date().getDate();
                  const votacionCerrada = diaActual >= 30 || diaActual === 1;

                  return (
                    <>
                      {votacionCerrada && (
                        <div className="p-3 mb-3 bg-[#faf9f5] border border-[#e6e4dc] rounded-xl text-center fade-in">
                          <p className="text-xs text-[#595750] font-sans italic">Votaciones cerradas por este mes. Procesando resultados...</p>
                        </div>
                      )}

                      <div className="space-y-3">
                        {[...propuestas].sort((a, b) => (Number(b.votos) || 0) - (Number(a.votos) || 0)).map((p, i) => (
                          <div key={i} className="flex gap-3 border border-[#e6e4dc] p-3.5 rounded-xl bg-[#ffffee]">
                            <PortadaLibroEstable titulo={p.titulo} autora={p.autora} portada={p.portada} size="small" />
                            <div className="flex flex-col justify-between w-full">
                              <div>
                                <div className="flex items-center gap-1.5">
                                  <span className="text-xs font-bold text-[#3d4220]">#{i + 1}</span>
                                  <h4 className="font-bold text-base leading-tight font-babydoll">{p.titulo}</h4>
                                </div>
                                <p className="text-xs text-[#595750] italic">{p.autora}</p>
                              </div>
                              <button 
                                disabled={votacionCerrada}
                                onClick={()=>{
                                  if (votacionCerrada) return;
                                  const clon = [...propuestas]; 
                                  const item = clon.find(x => x.titulo === p.titulo); 
                                  if(!item) return;
                                  let arr = (item.votantes||"").toLowerCase().split(',').map(v=>v.trim()).filter(v=>v);
                                  if(arr.includes(sesion.email.toLowerCase())){ 
                                    arr = arr.filter(v=>v!==sesion.email.toLowerCase()); 
                                    item.votos = Math.max(0, Number(item.votos||0) - 1); 
                                  } else { 
                                    arr.push(sesion.email.toLowerCase()); 
                                    item.votos = Number(item.votos||0) + 1; 
                                  }
                                  item.votantes = arr.join(','); 
                                  setPropuestas(clon); 
                                  enviarAccion('votar', { tipo: 'propuesta', id: p.titulo, email: sesion.email }); 
                                  registrarActividadPresencia(); 
                                  mostrarToast('Voto actualizado.');
                                }} 
                                className={`self-start mt-2 px-3.5 py-1 text-xs rounded-full font-bold transition-all ${
                                  votacionCerrada 
                                    ? 'bg-gray-100 text-gray-400 border border-gray-200 cursor-not-allowed opacity-60' 
                                    : 'bg-[#FFFFFF] text-[#1c1c1a] border border-[#e6e4dc] hover:bg-[#3d4220] hover:text-white'
                                }`}
                              >
                                Votar ({p.votos||0})
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  );
                })()}
              </div>
            </div>
          )}

          {subTabComunidad === 'buzon' && (
            <div className="editorial-card p-5 space-y-3">
              <h2 className="font-babydoll text-2xl font-bold">Buzón privado</h2>
              <p className="text-xs text-[#595750] font-sans">Sugerencias y comunicación directa con la administración.</p>
              <textarea placeholder="Escribe tu mensaje..." value={mensajeFundadora} onChange={e=>setMensajeFundadora(e.target.value)} className="w-full editorial-input p-3 text-xs h-28 resize-none"></textarea>
              <button onClick={()=>{ enviarAccion('buzon',{mensaje:mensajeFundadora}); registrarActividadPresencia(); setMensajeFundadora(''); mostrarToast('Mensaje enviado.');}} className="w-full editorial-btn py-2.5 text-xs">Enviar mensaje</button>
            </div>
          )}
        </div>

        <div style={{ display: seccionApp === 'admin' && esAdministradora ? 'block' : 'none' }} aria-hidden={!esAdministradora || seccionApp !== 'admin'} className="space-y-4 fade-in">
          {esAdministradora && (
            <>
              <section className="editorial-card p-5 space-y-4">
                <header className="flex items-center justify-between gap-3 border-b border-[#e6e4dc] pb-3">
                  <div>
                    <p className="text-[10px] uppercase font-bold text-[#756a58] font-sans">herramientas editoriales</p>
                    <h1 className="font-babydoll text-2xl font-bold text-[#232321]">Panel de administración</h1>
                  </div>
                  <span className="rounded-full bg-[#f3eadb] border border-[#d8cdb8] px-2.5 py-1 text-[9px] font-bold text-[#6c5b42]">ADMIN</span>
                </header>
                <div>
                  <h2 className="font-babydoll text-lg font-bold">Lectura activa</h2>
                  <p className="mb-3 text-[10px] text-[#756a58] font-sans">El relevo de lectura se controla manualmente desde aquí.</p>
                  <form key={`${libroActual.titulo}-${libroActual.autora}`} onSubmit={adminGuardarLecturaActiva} className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <label className="space-y-1 text-[10px] font-bold text-[#595750] font-sans">Título
                      <input name="titulo" defaultValue={libroActual.titulo} required className="editorial-input w-full p-2.5 text-xs font-normal" />
                    </label>
                    <label className="space-y-1 text-[10px] font-bold text-[#595750] font-sans">Autora
                      <input name="autora" defaultValue={libroActual.autora} className="editorial-input w-full p-2.5 text-xs font-normal" />
                    </label>
                    <label className="space-y-1 text-[10px] font-bold text-[#595750] font-sans">URL de portada
                      <input name="portada" type="url" defaultValue={libroActual.portada} className="editorial-input w-full p-2.5 text-xs font-normal" />
                    </label>
                    <label className="space-y-1 text-[10px] font-bold text-[#595750] font-sans">Páginas totales
                      <input name="paginas_totales" type="number" min="1" defaultValue={libroActual.paginas_totales || 280} className="editorial-input w-full p-2.5 text-xs font-normal" />
                    </label>
                    <button type="submit" className="sm:col-span-2 editorial-btn py-2.5 text-xs">Guardar lectura activa</button>
                  </form>
                </div>
              </section>

              <div className="grid grid-cols-1 gap-4">
                <section className="editorial-card p-4 space-y-3">
                  <div className="flex justify-between items-baseline gap-2">
                    <h2 className="font-babydoll text-lg font-bold">Moderación del chat</h2>
                    <span className="text-[10px] text-[#756a58] font-sans">últimos 12 mensajes</span>
                  </div>
                  {chatMsgs.length === 0 ? <p className="text-xs text-[#756a58] italic">No hay mensajes cargados.</p> : (
                    <div className="divide-y divide-[#e6e4dc]">
                      {chatMsgs.slice(-12).reverse().map((mensaje, visibleIndex) => {
                        const indice = chatMsgs.length - 1 - visibleIndex;
                        return (
                          <div key={`${mensaje.timestamp || mensaje.email}-${indice}`} className="flex items-start gap-3 py-2.5">
                            <div className="min-w-0 flex-grow">
                              <p className="text-[10px] font-bold text-[#3d4220]">{mensaje.usuario || mensaje.email || 'Socia'} · {mensaje.tipo || 'global'}</p>
                              <p className="break-words text-xs text-[#232321]">{mensaje.mensaje}</p>
                              <p className="text-[9px] text-[#756a58]">{mensaje.timestamp || mensaje.fecha || ''}</p>
                            </div>
                            <button type="button" onClick={() => adminEliminarMensajeChat(indice)} title="Retirar mensaje" className="shrink-0 rounded-lg border border-[#e6e4dc] px-2.5 py-1.5 text-[10px] font-bold text-[#8b4038] hover:bg-[#fff4f1]">Retirar</button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>

                <section className="editorial-card p-4 space-y-3">
                  <div className="flex justify-between items-baseline gap-2">
                    <h2 className="font-babydoll text-lg font-bold">Propuestas del club</h2>
                    <span className="text-[10px] text-[#756a58] font-sans">{propuestas.length} propuestas</span>
                  </div>
                  {propuestas.map((propuesta, indice) => (
                    <div key={`${propuesta.titulo}-${indice}`} className="flex items-center gap-3 border-t border-[#e6e4dc] py-2.5">
                      <PortadaLibroEstable titulo={propuesta.titulo} autora={propuesta.autora} portada={propuesta.portada} size="thumb" />
                      <div className="min-w-0 flex-grow">
                        <p className="truncate font-babydoll text-sm font-bold">{propuesta.titulo}</p>
                        <p className="truncate text-[10px] text-[#756a58]">{propuesta.autora || 'Autora no indicada'} · {propuesta.votos || 0} votos</p>
                      </div>
                      <button type="button" onClick={() => adminEliminarPropuesta(indice)} className="shrink-0 rounded-lg border border-[#e6e4dc] px-2.5 py-1.5 text-[10px] font-bold text-[#8b4038] hover:bg-[#fff4f1]">Retirar</button>
                    </div>
                  ))}
                </section>

                <section className="editorial-card p-4 space-y-3">
                  <div className="flex justify-between items-baseline gap-2">
                    <h2 className="font-babydoll text-lg font-bold">Validación de capítulos</h2>
                    <span className="text-[10px] text-[#756a58] font-sans">{capitulos.length} capítulos</span>
                  </div>
                  {capitulos.map((capitulo, indice) => {
                    const oculto = ['oculto', 'borrador'].includes(String(capitulo.estado || '').toLowerCase());
                    return (
                      <div key={`${capitulo.id || capitulo.titulo}-${indice}`} className="flex items-center gap-3 border-t border-[#e6e4dc] py-2.5">
                        <div className="min-w-0 flex-grow">
                          <p className="truncate font-babydoll text-sm font-bold">{capitulo.titulo || `Capítulo ${indice + 1}`}</p>
                          <p className="text-[10px] text-[#756a58]">{oculto ? 'Oculto' : 'Visible'} · pág. {capitulo.pagina_fin || capitulo.pagina || 0}</p>
                        </div>
                        <button type="button" onClick={() => adminAlternarCapitulo(indice)} className="shrink-0 rounded-lg border border-[#e6e4dc] px-2.5 py-1.5 text-[10px] font-bold text-[#3d4220] hover:bg-[#faf9f5]">{oculto ? 'Publicar' : 'Ocultar'}</button>
                      </div>
                    );
                  })}
                </section>
              </div>
            </>
          )}
        </div>
      </main>

      <nav className="editorial-nav fixed bottom-0 left-0 right-0 py-3 px-4 flex justify-around items-center max-w-lg mx-auto z-40 rounded-t-2xl shadow-lg">
        {[
          { id: 'inicio', icon: 'fa-house', label: 'inicio' },
          { id: 'edificio', icon: 'fa-building', label: 'casa' },
          { id: 'habitacion', icon: 'fa-bookmark', label: 'habitación' },
          { id: 'capitulos', icon: 'fa-book-open', label: 'capítulos' },
          { id: 'muro', icon: 'fa-feather', label: 'muro' },
          { id: 'comunidad', icon: 'fa-mug-hot', label: 'comunidad' },
          ...(esAdministradora ? [{ id: 'admin', icon: 'fa-screwdriver-wrench', label: 'admin' }] : [])
        ].map(tab => {
          const esComunidad = tab.id === 'comunidad';
          const bloqueado = esRestringida && esComunidad;

          return (
            <button 
              key={tab.id} 
              onClick={() => {
                registrarActividadPresencia();
                if (bloqueado) setMostrarModalUpgrade(true);
                else setSeccionApp(tab.id);
              }} 
              title={bloqueado ? 'Actualiza tu modalidad para acceder a la comunidad' : tab.label}
              aria-haspopup={bloqueado ? 'dialog' : undefined}
              className={`flex flex-col items-center gap-1 transition-all p-1.5 ${seccionApp === tab.id && !bloqueado ? 'text-[#1c1c1a] font-bold bg-[#faf9f5] px-3.5 py-1.5 rounded-xl shadow-sm' : 'text-[#595750] hover:text-gray-800'} ${bloqueado ? 'opacity-50' : ''}`}
            >
              <i className={`fa-solid ${bloqueado ? 'fa-lock' : tab.icon} ${bloqueado ? 'text-xs' : 'text-sm'}`}></i>
              <span className="text-[9px] font-bold lowercase font-sans">{tab.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}