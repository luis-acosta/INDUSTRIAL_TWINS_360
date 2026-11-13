/**
 * El recorrido publicado, abierto con un navegador de verdad.
 *
 * Estas pruebas valen por lo que no pueden comprobar las unitarias: el
 * contrato entre el exportador y el visor. Son dos mitades escritas por
 * separado y cada una pasa sus pruebas estando de acuerdo consigo misma; lo
 * que aquí se verifica es que estén de acuerdo entre ellas.
 *
 * Concretamente: que el HTML que genera el exportador cargue el JavaScript que
 * compila el visor, que el visor encuentre el manifiesto donde el exportador lo
 * escribe, que lo valide sin quejarse, y que lo que sale en pantalla sea el
 * recorrido y no un mensaje de error.
 *
 * El paquete que se sirve lo genera `tools/make-sample-package.ts` con el
 * exportador real y el visor real compilado. No hay simulaciones en el camino.
 */
import { expect, test } from '@playwright/test';

/** Errores de consola que no delatan un problema del producto. */
const RUIDO_ESPERADO = [
  // WebGL por software en el contenedor: avisos del controlador, no del visor.
  'swiftshader',
  'GroupMarkerNotSet',
  'Automatic fallback to software WebGL',
  'WebGL',
];

test.describe('recorrido publicado', () => {
  test('carga el manifiesto que escribió el exportador y dibuja el recorrido', async ({ page }) => {
    // TEST-E2E-001
    const errores: string[] = [];
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (RUIDO_ESPERADO.some((noise) => text.includes(noise))) return;
      errores.push(text);
    });

    await page.goto('/');

    // El título sale del manifiesto, no del HTML: si el visor no hubiera
    // podido leerlo, seguiría poniendo el título genérico del índice.
    const barra = page.getByRole('banner');
    await expect(barra.getByText('Unidad U-200 — paquete de prueba')).toBeVisible();

    // La escena de entrada es la que declara el manifiesto. Se mira en la
    // barra y no en cualquier sitio: el nombre también aparece en la lista de
    // navegación, y un localizador ambiguo falla por una razón que no es el
    // producto.
    await expect(barra.getByText('Sala de bombas')).toBeVisible();

    // Y no hay ningún mensaje de error de carga.
    await expect(page.getByText('No se pudo abrir el recorrido')).toHaveCount(0);
    expect(errores, `Errores de consola: ${errores.join(' | ')}`).toEqual([]);
  });

  test('el lienzo del visor existe y tiene tamaño', async ({ page }) => {
    // TEST-E2E-002: un lienzo de 0×0 es el síntoma de que el visor montó pero
    // no se le dio sitio, y la pantalla se ve negra sin ningún error.
    await page.goto('/');

    const canvas = page.locator('canvas').first();
    await expect(canvas).toBeVisible();

    const box = await canvas.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(200);
    expect(box?.height ?? 0).toBeGreaterThan(200);
  });

  test('navega entre escenas al pulsar el marcador del recorrido', async ({ page }) => {
    // TEST-E2E-003: recorre el camino completo —marcador del manifiesto,
    // ejecutor de acciones, resolución de la vista de entrada, cambio de
    // escena— con un clic real sobre el marcador, no sobre el menú.
    await page.goto('/');
    const barra = page.getByRole('banner');
    await expect(barra.getByText('Sala de bombas')).toBeVisible();

    await page.getByRole('button', { name: 'A la plataforma' }).click();

    await expect(barra.getByText('Plataforma superior')).toBeVisible();
  });

  test('navega también desde la lista de escenas', async ({ page }) => {
    // TEST-E2E-009: es la vía que usa quien no encuentra el marcador, y en una
    // planta con cuarenta escenas es la principal.
    await page.goto('/');
    const barra = page.getByRole('banner');

    await page.getByRole('button', { name: 'Plataforma superior' }).click();

    await expect(barra.getByText('Plataforma superior')).toBeVisible();
  });

  test('la interfaz que diseñó el autor se dibuja sobre el recorrido', async ({ page }) => {
    // TEST-E2E-020: el skin no se dibujaba en ninguna parte. Aquí se comprueba
    // con disposición de verdad, que es lo único que jsdom no puede dar.
    await page.goto('/');

    const barra = page.locator('.skin-node--container').first();
    await expect(barra).toBeVisible();

    // La plantilla del autor llegó con la variable sustituida y con formato.
    await expect(barra.locator('strong', { hasText: 'Sala de bombas' })).toBeVisible();

    // Y está donde el autor la ancló: abajo, dentro del escenario.
    const caja = await barra.boundingBox();
    const escena = await page.locator('.tour__stage').boundingBox();
    expect(caja).not.toBeNull();
    expect(escena).not.toBeNull();
    expect((caja?.y ?? 0) + (caja?.height ?? 0)).toBeLessThanOrEqual(
      (escena?.y ?? 0) + (escena?.height ?? 0) + 1,
    );
    expect(caja?.y ?? 0).toBeGreaterThan((escena?.y ?? 0) + (escena?.height ?? 0) / 2);
  });

  test('un botón de la interfaz ejecuta su acción', async ({ page }) => {
    // TEST-E2E-021: el camino completo —componente, acción, anfitrión— con un
    // clic real sobre el botón que el autor colocó.
    await page.goto('/');

    await page.getByRole('button', { name: 'Plano de planta' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('dialog').getByRole('img', { name: /Plano/ })).toBeVisible();
  });

  test('la lista de miniaturas de la interfaz navega y marca la escena actual', async ({
    page,
  }) => {
    // TEST-E2E-022: F13.
    await page.goto('/');
    const barra = page.getByRole('banner');

    const lista = page.locator('.skin-thumbs');
    await expect(lista).toBeVisible();
    await expect(lista.locator('.skin-thumb--current')).toHaveCount(1);

    await lista.getByRole('button', { name: /Plataforma superior/ }).click();
    await expect(barra.getByText('Plataforma superior')).toBeVisible();
  });

  test('una acción de la interfaz oculta y vuelve a mostrar un componente', async ({ page }) => {
    // TEST-E2E-024: J05 de principio a fin —botón, ejecutor de acciones,
    // estado de la interfaz, dibujado—. Es el camino que no cubre ninguna
    // prueba unitaria: cada mitad funciona por separado.
    await page.goto('/');

    const lista = page.locator('.skin-thumbs');
    await expect(lista).toBeVisible();

    await page.getByRole('button', { name: 'Ocultar escenas' }).click();
    await expect(lista).toHaveCount(0);

    await page.getByRole('button', { name: 'Ocultar escenas' }).click();
    await expect(page.locator('.skin-thumbs')).toBeVisible();
  });

  test('la interfaz no captura el puntero en sus huecos', async ({ page }) => {
    // TEST-E2E-023: el lienzo de la interfaz cubre el escenario entero. Si
    // capturase el puntero en las zonas vacías, arrastrar no giraría la
    // panorámica y el visor parecería congelado. Es un fallo que no se ve
    // mirando, sólo arrastrando, y que ninguna prueba en jsdom puede detectar
    // porque allí no hay superposición real.
    await page.goto('/');

    const caja = await page.locator('.tour__stage').boundingBox();
    expect(caja).not.toBeNull();

    // Varios puntos libres: cerca de cada borde y en el centro. Lo que se
    // comprueba no es qué hay debajo —un marcador, el lienzo— sino que no sea
    // la interfaz.
    const puntos = [
      [0.2, 0.2],
      [0.5, 0.5],
      [0.8, 0.35],
      [0.2, 0.75],
    ] as const;

    for (const [fx, fy] of puntos) {
      const x = (caja?.x ?? 0) + (caja?.width ?? 0) * fx;
      const y = (caja?.y ?? 0) + (caja?.height ?? 0) * fy;

      const dentroDeLaInterfaz = await page.evaluate(
        ([px, py]) => {
          const el = document.elementFromPoint(px as number, py as number);
          return el !== null && el.closest('.skin') !== null;
        },
        [x, y],
      );

      expect(dentroDeLaInterfaz, `punto (${fx}, ${fy})`).toBe(false);
    }
  });

  test('una ventana de información se abre con su contenido compuesto', async ({ page }) => {
    // TEST-E2E-017: el texto con formato, el pie de la imagen y las pestañas
    // sólo se pueden comprobar con el paquete real y un navegador real.
    await page.goto('/');

    await page.getByRole('button', { name: /Ficha del equipo/ }).click();
    const dialogo = page.getByRole('dialog');

    // El título llegó con la variable sustituida.
    await expect(dialogo.getByRole('heading', { name: 'Ficha de Sala de bombas' })).toBeVisible();

    // El formato se pintó como elementos, no como texto con asteriscos.
    await expect(dialogo.locator('strong', { hasText: 'P-101A' })).toBeVisible();
    await expect(dialogo.getByRole('listitem')).toHaveCount(2);
    await expect(dialogo.getByRole('link', { name: 'norma de arranque' })).toHaveAttribute(
      'rel',
      /noopener/,
    );

    // La imagen del plano se resolvió a un archivo del paquete.
    const imagen = dialogo.getByRole('img', { name: 'Ubicación en el plano' });
    await expect(imagen).toBeVisible();
    expect(await imagen.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(
      0,
    );
  });

  test('las pestañas de la ventana cambian el contenido', async ({ page }) => {
    // TEST-E2E-018: F08. Y de paso el contenido web no declarado, que debe
    // explicarse en lugar de dejar un recuadro en blanco.
    await page.goto('/');
    await page.getByRole('button', { name: /Ficha del equipo/ }).click();

    const dialogo = page.getByRole('dialog');
    await dialogo.getByRole('tab', { name: 'Enlaces' }).click();

    // Un bloque de contenido web es, de por sí, una declaración del autor: su
    // origen entra en la política al publicar y el visor lo enmarca, con los
    // permisos mínimos —sin `allow-same-origin`, el marco no puede leer nada
    // del recorrido—. Lo que no entra en la política es lo que la propia
    // publicación rechaza, y ese es el segundo bloque.
    const marco = dialogo.locator('iframe');
    await expect(marco).toHaveCount(1);
    await expect(marco).toHaveAttribute('src', 'https://mapa.ejemplo.com/embed');
    const sandbox = (await marco.getAttribute('sandbox')) ?? '';
    expect(sandbox).toContain('allow-scripts');
    expect(sandbox).not.toContain('allow-same-origin');

    // El que no se declaró se explica en lugar de dejar un recuadro en blanco.
    await expect(dialogo.getByText('Este contenido no se puede mostrar aquí')).toBeVisible();
    await expect(dialogo.getByRole('link', { name: 'Abrirla aparte' })).toBeVisible();
  });

  test('un enlace de la ventana lleva a su escena', async ({ page }) => {
    // TEST-E2E-019: cierra la ventana y navega, que son dos pasos y el segundo
    // depende del primero.
    await page.goto('/');
    const barra = page.getByRole('banner');
    await expect(barra.getByText('Sala de bombas')).toBeVisible();

    await page.getByRole('button', { name: /Ficha del equipo/ }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Ir a Plataforma superior' })
      .click();

    await expect(barra.getByText('Plataforma superior')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('el plano sitúa la escena y dibuja el radar de mirada', async ({ page }) => {
    // TEST-E2E-014: el radar sólo se puede comprobar aquí. En jsdom la imagen
    // del plano no tiene tamaño, así que el visor no dibuja el cono y la
    // prueba unitaria no puede afirmar nada sobre su geometría.
    await page.goto('/');

    await page.getByRole('button', { name: 'Ver el plano' }).click();
    const dialogo = page.getByRole('dialog');
    await expect(dialogo.getByRole('img', { name: /Plano/ })).toBeVisible();

    // El cono existe y tiene área: un polígono degenerado no dice nada.
    const radar = dialogo.locator('.planview__radar path');
    await expect(radar).toHaveCount(1);
    const caja = await radar.boundingBox();
    expect(caja?.width ?? 0).toBeGreaterThan(4);
    expect(caja?.height ?? 0).toBeGreaterThan(4);

    // Y el rumbo se declara, que es lo que el visitante lee.
    await expect(dialogo.getByText(/rumbo/i)).toBeVisible();
  });

  test('el plano lleva a la escena del punto que se pulsa', async ({ page }) => {
    // TEST-E2E-015: el camino completo del plano —punto, cierre del diálogo,
    // transición y cambio de escena— con un clic real.
    await page.goto('/');
    const barra = page.getByRole('banner');
    await expect(barra.getByText('Sala de bombas')).toBeVisible();

    await page.getByRole('button', { name: 'Ver el plano' }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Ir a Plataforma superior' })
      .click();

    await expect(barra.getByText('Plataforma superior')).toBeVisible();
  });

  test('el radar desaparece en un plano que no sitúa la escena actual', async ({ page }) => {
    // TEST-E2E-016: un cono colocado «por poner algo» afirma una posición
    // falsa, y el visitante se fía del radar.
    await page.goto('/');
    await page.getByRole('button', { name: 'Ver el plano' }).click();

    const dialogo = page.getByRole('dialog');
    await expect(dialogo.locator('.planview__radar')).toHaveCount(1);

    // Se quita el punto de la escena actual del manifiesto cargado no se
    // puede; en su lugar se navega a la otra escena y se comprueba que el
    // radar se mueve con ella en lugar de quedarse donde estaba.
    const antes = await dialogo.locator('.planview__radar path').boundingBox();
    await dialogo.getByRole('button', { name: 'Ir a Plataforma superior' }).click();
    await page.getByRole('button', { name: 'Ver el plano' }).click();
    const despues = await page
      .getByRole('dialog')
      .locator('.planview__radar path')
      .boundingBox();

    expect(despues).not.toBeNull();
    expect(Math.abs((despues?.x ?? 0) - (antes?.x ?? 0))).toBeGreaterThan(10);
  });

  test('no pide datos de proceso cuando el paquete no los trae', async ({ page }) => {
    // TEST-E2E-004: el paquete de prueba no declara telemetría. Si el visor
    // consultara igualmente, el navegador del cliente llenaría la consola de
    // errores de red y el operador los leería como una planta en fallo.
    const peticiones: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/telemetry')) peticiones.push(request.url());
    });

    await page.goto('/');
    await expect(page.getByRole('banner').getByText('Sala de bombas')).toBeVisible();
    await page.waitForTimeout(1500);

    expect(peticiones).toEqual([]);
  });

  test('el paquete servido no contiene credenciales', async ({ page, request }) => {
    // TEST-E2E-005: la comprobación se hace sobre lo que el servidor entrega
    // de verdad, no sobre la estructura en memoria del exportador.
    const manifest = await request.get('/manifiesto.json');
    expect(manifest.ok()).toBe(true);

    const texto = await manifest.text();

    /* Se buscan **claves** y no subcadenas: `surfaceToken` —el fondo del
       sistema de diseño— contiene «token» y es legítimo, mientras que una
       clave llamada `token` es exactamente lo que no puede viajar. Buscar la
       subcadena daba un fallo por un nombre de campo inocuo, y un día habría
       llevado a relajar la comprobación entera. */
    for (const prohibido of [
      'tokenRef',
      'token',
      'password',
      'secret',
      'apiKey',
      'credential',
      'telemetryConnections',
      'auditLog',
      'grants',
      'users',
    ]) {
      expect(texto, `El manifiesto trae la clave «${prohibido}»`).not.toContain(`"${prohibido}":`);
    }

    // Y lo que de verdad delataría una credencial: el valor de un token de
    // InfluxDB empieza siempre por este prefijo.
    expect(texto).not.toContain('influxdb-token');

    // El índice tampoco trae ninguna clave de esas.
    const index = await request.get('/index.html');
    const indexText = await index.text();
    for (const prohibido of ['tokenRef', 'password', 'apiKey']) {
      expect(indexText).not.toContain(`"${prohibido}":`);
    }
    await page.goto('/');
  });

  test('las sumas de verificación corresponden a los archivos servidos', async ({ request }) => {
    // TEST-E2E-006: el archivo de sumas existe para que el cliente pueda
    // comprobar que su copia está completa. Si las sumas no correspondieran,
    // sería peor que no tenerlas: una comprobación que siempre falla se ignora.
    const sums = await request.get('/SUMAS.txt');
    expect(sums.ok()).toBe(true);

    const lines = (await sums.text()).trim().split('\n');
    expect(lines.length).toBeGreaterThan(3);

    for (const line of lines) {
      const [hash, path] = line.split(/\s{2}/);
      expect(hash, `Suma mal formada: ${line}`).toMatch(/^[0-9a-f]{64}$/);

      const file = await request.get(`/${path}`);
      expect(file.ok(), `Falta el archivo ${path} que declara SUMAS.txt`).toBe(true);

      const digest = await sha256Hex(await file.body());
      expect(digest, `La suma de ${path} no corresponde`).toBe(hash);
    }
  });

  test('la política de seguridad del contenido se declara', async ({ request }) => {
    // TEST-E2E-007
    const index = await request.get('/index.html');
    const html = await index.text();

    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain('object-src');
    expect(html).not.toContain('unsafe-eval');
  });

  test('se puede tomar una nota de campo anclada al punto que se está mirando', async ({
    page,
  }) => {
    // TEST-E2E-009: es el requisito P01 de extremo a extremo, en el único
    // sitio donde se puede comprobar de verdad. Lo que se verifica es que la
    // nota escrita en el recorrido publicado sobreviva a una recarga de la
    // página: una observación tomada en planta, en una tableta sin cobertura,
    // no puede depender de que el navegador no se refresque.
    await page.goto('/');

    await page.getByRole('button', { name: 'Notas de campo' }).click();
    const dialogo = page.getByRole('dialog', { name: 'Notas de campo' });
    await expect(dialogo).toBeVisible();

    // Dice con todas las letras dónde quedan, que es lo que evita que alguien
    // tome doce observaciones creyendo que llegan solas a alguna parte.
    await expect(dialogo.getByText(/guardadas en este navegador/)).toBeVisible();

    // Sin asunto y sin nombre no se guarda.
    const guardar = dialogo.getByRole('button', { name: 'Guardar la nota' });
    await expect(guardar).toBeDisabled();

    await dialogo.getByLabel('Asunto').fill('Goteo en la brida de aspiración');
    await dialogo.getByLabel('Qué se observa').fill('Charco bajo la bomba, goteo continuo.');
    await dialogo.getByLabel('Su nombre').fill('Operador de turno');
    await expect(guardar).toBeEnabled();
    await guardar.click();

    await expect(dialogo.getByText('Notas tomadas (1)')).toBeVisible();
    await expect(
      dialogo.getByRole('button', { name: /^Descargar 1 nota/ }),
    ).toBeEnabled();

    // La prueba de fondo: recargar y seguir ahí.
    await page.reload();
    await page.getByRole('button', { name: 'Notas de campo' }).click();
    const tras = page.getByRole('dialog', { name: 'Notas de campo' });

    await expect(tras.getByText('Notas tomadas (1)')).toBeVisible();
    await expect(tras.getByText('Goteo en la brida de aspiración')).toBeVisible();
    // Y el nombre del autor se recuerda, para no teclearlo doce veces.
    await expect(tras.getByLabel('Su nombre')).toHaveValue('Operador de turno');
  });

  test('abre un álbum de fotografías dentro del recorrido', async ({ page }) => {
    // TEST-E2E-010: antes, una foto se abría en una pestaña nueva. El
    // visitante salía del recorrido y un álbum era imposible, porque en una
    // pestaña nueva no hay «siguiente». Esto comprueba el camino completo
    // contra el paquete real: acción, ventana, navegación y cierre.
    await page.goto('/');

    await page.getByRole('button', { name: 'Fotos de detalle' }).click();

    const ventana = page.getByRole('dialog');
    await expect(ventana).toBeVisible();

    // La posición dice en qué foto se está: sin eso, el visitante no sabe si
    // ha visto el álbum entero.
    await expect(ventana.getByText('1 de 2')).toBeVisible();

    // No da la vuelta: en la primera, «Anterior» está desactivado.
    await expect(ventana.getByRole('button', { name: 'Anterior' })).toBeDisabled();
    await ventana.getByRole('button', { name: 'Siguiente' }).click();

    await expect(ventana.getByText('2 de 2')).toBeVisible();
    await expect(ventana.getByRole('button', { name: 'Siguiente' })).toBeDisabled();
    await expect(ventana.getByRole('button', { name: 'Anterior' })).toBeEnabled();

    // Escape cierra, que es lo primero que prueba cualquiera.
    await page.keyboard.press('Escape');
    await expect(ventana).toBeHidden();

    // Y el recorrido sigue ahí: no se abrió ninguna pestaña nueva.
    await expect(page.getByRole('banner')).toBeVisible();
    expect(page.context().pages()).toHaveLength(1);
  });

  test('la política admite enmarcar el propio paquete y nada de terceros', async ({ request }) => {
    // TEST-E2E-011: `frame-src 'self'` es lo que permite mostrar un PDF del
    // recorrido dentro del recorrido. La alternativa fácil habría sido un
    // comodín, que convertiría cada marco en una ventana a la que nadie ha
    // dado el visto bueno.
    const index = await request.get('/index.html');
    const html = await index.text();

    expect(html).toContain("frame-src &#39;self&#39;");
    expect(html).not.toMatch(/frame-src[^;&]*\*/);
    expect(html).toContain('object-src &#39;none&#39;');
  });

  test('funciona servido desde una subcarpeta', async ({ page }) => {
    // TEST-E2E-008: la publicación habitual del cliente es una subcarpeta de
    // su intranet. Con rutas absolutas no cargaría ni un archivo, y es un
    // fallo que no se ve probando en la raíz.
    //
    // Se comprueba sobre el HTML servido: las rutas son relativas o no lo son.
    const index = await page.request.get('/index.html');
    const html = await index.text();

    expect(html).toContain('src="./viewer/');
    expect(html).not.toContain('src="/viewer/');
    expect(html).not.toContain('href="/viewer/');
  });
});

/** SHA-256 en hexadecimal, con la API del entorno de Node. */
async function sha256Hex(data: Buffer): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(data).digest('hex');
}

test('la transición entre escenas se dibuja con la escena de la que se sale', async ({ page }) => {
  // TEST-E2E-013: es lo único que no puede comprobar una prueba unitaria.
  // La capa de transición necesita una fotografía real del lienzo WebGL, y eso
  // exige un navegador de verdad: en jsdom no hay lienzo que fotografiar, así
  // que allí sólo se puede comprobar que la ausencia de fotografía no impide
  // navegar. Aquí se comprueba lo contrario: que cuando sí hay lienzo, la capa
  // se monta con la imagen de la escena de origen.
  await page.goto('/');
  const barra = page.getByRole('banner');
  await expect(barra.getByText('Sala de bombas')).toBeVisible();

  await page.getByRole('button', { name: 'A la plataforma' }).click();

  const capa = page.locator('.transition-overlay');
  await expect(capa).toBeAttached({ timeout: 2000 });

  // La fotografía es una imagen de verdad, no un rectángulo vacío.
  const fondo = await capa.evaluate((el) => getComputedStyle(el).backgroundImage);
  expect(fondo).toContain('data:image');
  expect(fondo.length).toBeGreaterThan(2000);

  // Y la escena ya cambió: la transición no retrasa la navegación.
  await expect(barra.getByText('Plataforma superior')).toBeVisible();

  // Al terminar, la capa desaparece y deja de tapar la escena nueva.
  await expect(capa).toHaveCount(0, { timeout: 4000 });
});
