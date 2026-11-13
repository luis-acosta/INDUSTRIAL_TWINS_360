/**
 * Pruebas del armazón de la aplicación.
 *
 * Lo que se comprueba aquí no es que los componentes se pinten, sino las
 * reglas que, si se rompieran, dejarían pasar a un cliente un recorrido
 * incorrecto: que la publicación se bloquee con referencias rotas, que una
 * propuesta automática sin revisar se anuncie como tal, que el dato de caché
 * no se presente como telemetría en vivo y que el deshacer recorra los
 * comandos y no instantáneas.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  bundleFieldNotes,
  createFieldNote,
  newUuid,
  ok,
  type Result,
} from '@it360/domain';
import type {
  TelemetryClient,
  TelemetryHistory,
} from './telemetry/telemetry-client';
import type { TelemetryMapping, TelemetrySample } from '@it360/domain';
import { ToastProvider } from '@it360/ui';
import { App } from './App';
import { buildDemoProject, type DemoAssets } from './demo/demo-project';

/**
 * Cliente de telemetría de prueba.
 *
 * Devuelve lo que se le diga, sin temporizadores ni red, para que las pruebas
 * no dependan de un reloj. Se declara `kind: 'backend'` cuando interesa
 * comprobar que la etiqueta «simulado» aparece sólo donde debe.
 */
function fakeClient(options: {
  readonly kind?: 'backend' | 'simulated';
  readonly samples?: readonly TelemetrySample[];
}): TelemetryClient {
  return {
    kind: options.kind ?? 'backend',
    latest: async (): Promise<Result<readonly TelemetrySample[]>> => ok(options.samples ?? []),
    history: async (mapping: TelemetryMapping): Promise<Result<TelemetryHistory>> =>
      ok({ mappingId: mapping.id, points: [], windowSeconds: 60, fromCache: false }),
    ping: async () => ok({ reachable: true, latencyMs: 12 }),
  };
}

/**
 * El proyecto de demostración se construye una sola vez para toda la suite.
 *
 * Calcula sumas SHA-256 reales de tres panorámicas de 3072 px, y repetir ese
 * trabajo en cada prueba multiplicaría la duración sin comprobar nada nuevo.
 * Cada prueba recibe su propia copia del objeto raíz, de modo que las
 * ediciones de una no se filtran a la siguiente.
 */
let demoAssets: DemoAssets;

beforeAll(async () => {
  demoAssets = await buildDemoProject();
});

/**
 * Monta la aplicación y deja asentar el primer sondeo de telemetría.
 *
 * El sondeo resuelve en un microtask posterior al montaje, así que sin el
 * `act` React avisaría de una actualización fuera de su control en cada
 * prueba. Esperar aquí lo deja consistente para todas.
 */
async function renderApp(client?: TelemetryClient): Promise<void> {
  await act(async () => {
    render(
      <ToastProvider>
        <App
          initialProject={{ ...demoAssets.project }}
          initialMediaUrls={demoAssets.mediaUrls}
          telemetryClient={client ?? fakeClient({})}
        />
      </ToastProvider>,
    );
  });
}

describe('App — armazón', () => {
  // TEST-APP-001
  it('arranca en el módulo de escenas con la primera escena seleccionada', async () => {
    await renderApp();
    expect(screen.getByRole('navigation', { name: 'Módulos' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Escenas y marcadores/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const tree = screen.getByRole('tree', { name: 'Escenas y marcadores' });
    expect(within(tree).getAllByRole('treeitem').length).toBeGreaterThan(0);
  });

  // TEST-APP-002
  it('deshacer está deshabilitado al abrir y se habilita tras editar', async () => {
    const user = userEvent.setup();
    await renderApp();

    const undo = screen.getByRole('button', { name: 'Deshacer' });
    expect(undo).toBeDisabled();

    const title = screen.getByLabelText('Título');
    const original = (title as HTMLInputElement).value;
    await user.clear(title);
    await user.type(title, 'Caseta de válvulas');

    expect(undo).toBeEnabled();
    expect(screen.getByLabelText('Título')).toHaveValue('Caseta de válvulas');

    await user.click(undo);
    // Un solo deshacer devuelve todo el tecleo porque los comandos del mismo
    // campo se fusionan; si cada letra fuese un comando, el usuario tendría
    // que pulsar dieciocho veces para volver al punto de partida.
    expect(screen.getByLabelText('Título')).toHaveValue(original);
  });

  // TEST-APP-003
  it('la barra de estado cuenta escenas, marcadores y activos del proyecto', async () => {
    await renderApp();
    const status = screen.getByRole('contentinfo');
    const scenes = demoAssets.project.scenes.length;
    const hotspots = demoAssets.project.scenes.reduce((total, s) => total + s.hotspots.length, 0);
    expect(within(status).getByText(/^Escenas/)).toHaveTextContent(`Escenas ${scenes}`);
    expect(within(status).getByText(/^Marcadores/)).toHaveTextContent(`Marcadores ${hotspots}`);
  });

  // TEST-APP-004
  it('no etiqueta como simulada la telemetría de un servicio real', async () => {
    await renderApp(fakeClient({ kind: 'backend' }));
    await user_click('Telemetría');
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Telemetría', level: 1 })).toBeInTheDocument();
    });
    expect(screen.queryByText('simulado')).not.toBeInTheDocument();
  });

  // TEST-APP-005
  it('etiqueta la telemetría simulada para que nadie la confunda con la planta', async () => {
    await renderApp(fakeClient({ kind: 'simulated' }));
    await user_click('Telemetría');
    await waitFor(() => {
      expect(screen.getAllByText('simulado').length).toBeGreaterThan(0);
    });
  });

  // TEST-APP-006
  it('declara en el módulo de telemetría que el acceso es de sólo lectura', async () => {
    await renderApp();
    await user_click('Telemetría');
    expect(screen.getByText(/Acceso de sólo lectura por construcción/)).toBeInTheDocument();
    expect(screen.getByText(/latest, history, ping, listMeasurements/)).toBeInTheDocument();
  });

  // TEST-APP-007
  it('la publicación enumera lo que nunca sale del equipo', async () => {
    await renderApp();
    await user_click('Publicación');
    expect(screen.getByRole('heading', { name: 'Publicación', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('Tokens de InfluxDB')).toBeInTheDocument();
    expect(screen.getByText('Referencias a secretos')).toBeInTheDocument();
    expect(screen.getByText('Registro de auditoría')).toBeInTheDocument();
  });

  // TEST-APP-008
  it('la comprobación previa confirma que el manifiesto no lleva credenciales', async () => {
    await renderApp();
    await user_click('Publicación');
    expect(
      screen.getByText(/no contiene tokens, referencias a secretos ni conexiones/),
    ).toBeInTheDocument();
  });

  // TEST-APP-009
  it('los módulos se alcanzan con Alt y un dígito, no con el dígito solo', async () => {
    const user = userEvent.setup();
    await renderApp();

    // Escribir «4» en un campo de texto no debe cambiar de módulo.
    const title = screen.getByLabelText('Título');
    await user.click(title);
    await user.keyboard('4');
    expect(screen.getByRole('button', { name: /Escenas y marcadores/ })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await user.keyboard('{Alt>}4{/Alt}');
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Telemetría', level: 1 })).toBeInTheDocument();
    });
  });


  // TEST-APP-011
  it('buscar un TAG lleva a la ficha del activo y de ahí a su ubicación', async () => {
    // Es el recorrido del requisito X05, y sólo vale si cruza los tres
    // módulos: catálogo, ficha y escena.
    const user = userEvent.setup();
    await renderApp();
    const tag = demoAssets.project.assets.find((a) => a.level === 'equipment')?.tag;
    expect(tag).toBeDefined();

    await user.click(screen.getByRole('button', { name: /Catálogo de activos/ }));
    await user.type(screen.getByLabelText('Buscar activo'), tag as string);

    const tree = screen.getByRole('tree', { name: 'Jerarquía de activos' });
    const hit = within(tree).getByText(tag as string);
    await user.click(hit);

    const goToTour = await screen.findByRole('button', { name: 'Ver en el recorrido' });
    await user.click(goToTour);

    // Vuelve al módulo de escenas con la escena de la ubicación cargada.
    expect(screen.getByRole('button', { name: /Escenas y marcadores/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  // TEST-APP-012
  it('las notas se filtran por estado sin tocar el proyecto', async () => {
    const user = userEvent.setup();
    await renderApp();
    const total = demoAssets.project.notes.length;
    expect(total).toBeGreaterThan(1);

    await user.click(screen.getByRole('button', { name: /Notas y tareas/ }));
    const table = screen.getByRole('table', { name: 'Notas del proyecto' });
    const before = within(table).getAllByRole('row').length;

    await user.selectOptions(screen.getByLabelText('Filtrar por estado'), 'resolved');

    const after = within(screen.getByRole('table', { name: 'Notas del proyecto' })).getAllByRole('row').length;
    expect(after).toBeLessThan(before);
    // Filtrar es estado de interfaz: no debe ensuciar el proyecto ni aparecer
    // en el historial de deshacer.
    expect(screen.getByRole('button', { name: 'Deshacer' })).toBeDisabled();
  });

  // TEST-APP-013
  it('el selector de estado no ofrece cerrar ni archivar, que piden explicación', async () => {
    // Ofrecerlas en el selector daba un camino que siempre acababa en aviso de
    // error, porque ambas necesitan un dato que un selector no recoge: el
    // resumen de cómo se resolvió y el motivo del archivo.
    const user = userEvent.setup();
    await renderApp();

    await user.click(screen.getByRole('button', { name: /Notas y tareas/ }));
    const table = screen.getByRole('table', { name: 'Notas del proyecto' });
    await user.click(within(table).getAllByRole('row')[1] as HTMLElement);

    const statusSelect = await screen.findByLabelText('Estado');
    const values = [...statusSelect.querySelectorAll('option')].map((option) =>
      option.getAttribute('value'),
    );

    expect(values).not.toContain('resolved');
    expect(values).not.toContain('archived');
    // Y el camino correcto está señalado y disponible.
    expect(screen.getByText(/Resolver y archivar están en/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resolver' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archivar' })).toBeInTheDocument();
  });

  // TEST-APP-014
  it('la conexión automática no se ofrece si el proyecto no habilita lo experimental', async () => {
    const user = userEvent.setup();
    await renderApp();

    await user.click(screen.getByRole('button', { name: 'Más acciones' }));
    const item = await screen.findByRole('menuitem', {
      name: /Proponer conexiones automáticamente/,
    });

    // La configuración segura por defecto deja la función apagada, y la
    // interfaz lo refleja en lugar de ofrecerla y fallar al pulsarla.
    expect(item).toBeDisabled();
  });


  // TEST-APP-015
  it('un marcador sin acciones lo avisa, y se le puede añadir una', async () => {
    // Es el hueco que convertía el editor en un visor: se podían colocar
    // marcadores y no se les podía dar nada que hacer.
    const user = userEvent.setup();
    await renderApp();

    // Se selecciona el primer marcador del árbol.
    const tree = screen.getByRole('tree', { name: 'Escenas y marcadores' });
    const marcadores = within(tree)
      .getAllByRole('treeitem')
      .filter((item) => item.getAttribute('aria-level') === '2');
    expect(marcadores.length).toBeGreaterThan(0);
    await user.click(marcadores[0] as HTMLElement);

    await user.click(screen.getByRole('tab', { name: /Acciones/ }));

    const antes = screen.queryAllByRole('combobox', { name: 'Cuándo' }).length;

    await user.click(screen.getByRole('button', { name: 'Añadir acción' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Ir a otra escena' }));

    expect(screen.getAllByRole('combobox', { name: 'Cuándo' }).length).toBe(antes + 1);
    // Y la edición pasa por el historial, como cualquier otro cambio.
    expect(screen.getByRole('button', { name: 'Deshacer' })).toBeEnabled();
  });

  // TEST-APP-016
  it('no ofrece una acción cuyo destino no existe en el proyecto', async () => {
    // Crearla apuntando a nada produciría un marcador que falla en el visor y
    // el autor no sabría por qué.
    const user = userEvent.setup();
    await renderApp();

    const tree = screen.getByRole('tree', { name: 'Escenas y marcadores' });
    const marcadores = within(tree)
      .getAllByRole('treeitem')
      .filter((item) => item.getAttribute('aria-level') === '2');
    await user.click(marcadores[0] as HTMLElement);
    await user.click(screen.getByRole('tab', { name: /Acciones/ }));
    await user.click(screen.getByRole('button', { name: 'Añadir acción' }));

    // El proyecto de demostración no trae evaluaciones.
    const quiz = await screen.findByRole('menuitem', { name: /Iniciar una evaluación/ });
    expect(quiz).toBeDisabled();
    expect(quiz).toHaveTextContent('nada a lo que apuntar');
  });

  // TEST-APP-017
  it('la importación de catálogo enseña el informe antes de aplicar nada', async () => {
    // El contrato de la importación es que nada se escribe sin que el usuario
    // haya visto qué se va a escribir. Si el botón de aplicar apareciera antes
    // del informe, la revisión se convertiría en limpieza.
    const user = userEvent.setup();
    await renderApp();

    await user.click(screen.getByRole('button', { name: /Catálogo de activos/ }));
    await user.click(screen.getByRole('button', { name: 'Catálogo en CSV' }));

    const dialog = await screen.findByRole('dialog', { name: 'Catálogo en CSV' });
    expect(within(dialog).queryByRole('button', { name: /^Importar/ })).toBeNull();

    const csv = [
      'TAG;Nombre;Nivel;TAG padre',
      'PL-9;Planta importada;planta;',
      'U-900;Unidad importada;unidad;PL-9',
      'MAL 01;Equipo con TAG inválido;equipo;U-900',
    ].join('\n');

    const file = new File([csv], 'catalogo.csv', { type: 'text/csv' });
    await user.upload(within(dialog).getByLabelText('Archivo CSV del catálogo'), file);

    // Dos altas, y la fila inválida listada con su número de línea y motivo.
    expect(await within(dialog).findByText(/2 activo\(s\) nuevo\(s\)/)).toBeInTheDocument();
    const rechazadas = within(dialog).getByRole('table', { name: 'Filas rechazadas' });
    expect(within(rechazadas).getByText('4')).toBeInTheDocument();

    // Todavía no se ha tocado el proyecto.
    expect(screen.getByRole('button', { name: 'Deshacer' })).toBeDisabled();

    await user.click(within(dialog).getByRole('button', { name: 'Importar 2 activo(s)' }));

    expect(await within(dialog).findByText(/Importación aplicada/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deshacer' })).toBeEnabled();
  });

  // TEST-APP-018
  it('el editor de activos no deja guardar un TAG que ya existe', async () => {
    // El catálogo era de sólo lectura: se podía consultar un activo y no
    // crearlo. Y al poder crearlo, el TAG duplicado es el fallo que rompe la
    // búsqueda por TAG y la asignación de telemetría, así que bloquea.
    const user = userEvent.setup();
    await renderApp();

    await user.click(screen.getByRole('button', { name: /Catálogo de activos/ }));

    // Se toma el TAG de un activo que ya está en el proyecto.
    const tree = screen.getByRole('tree', { name: 'Jerarquía de activos' });
    const existente = within(tree).getAllByRole('treeitem')[0] as HTMLElement;
    const tagExistente = (existente.textContent ?? '').trim();

    await user.click(screen.getByRole('button', { name: 'Nuevo activo' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nuevo activo' });

    await user.type(within(dialog).getByLabelText(/TAG industrial/), tagExistente);
    await user.type(within(dialog).getByLabelText(/^Nombre/), 'Equipo duplicado');

    const guardar = within(dialog).getByRole('button', { name: 'Crear activo' });
    expect(guardar).toBeDisabled();
    expect(within(dialog).getByText(/Falta algo para poder guardar/)).toBeInTheDocument();

    // Con un TAG libre, y una vez resuelto lo demás, el botón se habilita.
    await user.clear(within(dialog).getByLabelText(/TAG industrial/));
    await user.type(within(dialog).getByLabelText(/TAG industrial/), 'ZZ-9001');
    await waitFor(() => {
      expect(within(dialog).getByText(/Falta algo para poder guardar/)).toBeInTheDocument();
    });
    // Lo que queda por resolver es la jerarquía, y el mensaje lo dice: aparece
    // en el resumen de arriba y junto al propio campo.
    expect(
      within(dialog).getAllByText(/necesita un elemento superior/).length,
    ).toBeGreaterThanOrEqual(1);
  });

  // TEST-APP-019
  it('crear un activo lo añade al catálogo y entra en el historial', async () => {
    const user = userEvent.setup();
    await renderApp();

    await user.click(screen.getByRole('button', { name: /Catálogo de activos/ }));
    const antes = screen.getByRole('tree', { name: 'Jerarquía de activos' });
    const cuentaAntes = within(antes).getAllByRole('treeitem').length;

    await user.click(screen.getByRole('button', { name: 'Nuevo activo' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nuevo activo' });

    await user.type(within(dialog).getByLabelText(/TAG industrial/), 'ZZ-9002');
    await user.type(within(dialog).getByLabelText(/^Nombre/), 'Equipo de prueba');
    // Nivel planta: es el único que no exige elemento superior.
    await user.selectOptions(within(dialog).getByLabelText(/^Nivel/), 'plant');

    const guardar = within(dialog).getByRole('button', { name: 'Crear activo' });
    await waitFor(() => {
      expect(guardar).toBeEnabled();
    });
    await user.click(guardar);

    const despues = screen.getByRole('tree', { name: 'Jerarquía de activos' });
    await waitFor(() => {
      expect(within(despues).getAllByRole('treeitem').length).toBe(cuentaAntes + 1);
    });
    expect(screen.getByRole('button', { name: 'Deshacer' })).toBeEnabled();
  });

  // TEST-APP-020
  it('el editor de clases cuenta los activos afectados al quitar un atributo con datos', async () => {
    // Quitar un atributo de una clase deja de mostrar un dato que sigue
    // guardado en cada activo. El autor tiene que ver a cuántos afecta antes
    // del clic, no descubrirlo recorriendo fichas.
    const user = userEvent.setup();
    await renderApp();

    await user.click(screen.getByRole('button', { name: /Catálogo de activos/ }));
    await user.click(screen.getByRole('button', { name: 'Clases de activo' }));

    const dialog = await screen.findByRole('dialog', { name: 'Clases de activo' });
    await user.click(within(dialog).getByRole('button', { name: /Bomba centrífuga/ }));

    // «Altura manométrica» está rellena en los activos del proyecto.
    await user.click(
      within(dialog).getByRole('button', { name: 'Quitar Altura manométrica' }),
    );

    const aviso = await within(dialog).findByText(/deja sin mostrar ese dato/);
    expect(aviso).toBeInTheDocument();
    expect(aviso.textContent).toMatch(/activo\(s\)/);
    // Dice además que el valor no se pierde, que es lo que decide si seguir.
    expect(aviso.textContent).toMatch(/sigue guardado/);

    // Y aun así se puede guardar: impedirlo convertiría en permanente un
    // atributo que el autor puso por error.
    expect(within(dialog).getByRole('button', { name: 'Guardar clase' })).toBeEnabled();
  });

  // TEST-APP-021
  it('el editor de clases no deja una magnitud sin unidad', async () => {
    // El contrato prohíbe inferir unidades: una presión de diseño sin unidad
    // es un dato inservible.
    const user = userEvent.setup();
    await renderApp();

    await user.click(screen.getByRole('button', { name: /Catálogo de activos/ }));
    await user.click(screen.getByRole('button', { name: 'Clases de activo' }));
    const dialog = await screen.findByRole('dialog', { name: 'Clases de activo' });

    await user.click(within(dialog).getByRole('button', { name: 'Añadir atributo' }));

    const claves = within(dialog).getAllByLabelText(/^Clave/);
    const etiquetas = within(dialog).getAllByLabelText(/^Etiqueta/);
    const tipos = within(dialog).getAllByLabelText(/^Tipo/);

    const i = claves.length - 1;
    await user.type(claves[i] as HTMLElement, 'presion_diseno');
    await user.type(etiquetas[i] as HTMLElement, 'Presión de diseño');
    await user.selectOptions(tipos[i] as HTMLElement, 'quantity');

    // El mensaje sale dos veces a propósito: en el resumen de arriba y junto
    // al campo que hay que corregir.
    await waitFor(() => {
      expect(within(dialog).getAllByText(/no se puede inferir/).length).toBeGreaterThan(0);
    });
    expect(within(dialog).getByRole('button', { name: 'Guardar clase' })).toBeDisabled();

    // Con la unidad declarada, se puede guardar.
    const unidades = within(dialog).getAllByLabelText(/^Unidad/);
    await user.type(unidades[unidades.length - 1] as HTMLElement, 'bar');

    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Guardar clase' })).toBeEnabled();
    });
  });

  // TEST-APP-022
  it('resolver una nota exige decir cómo se resolvió', async () => {
    // Una nota cerrada sin resumen no informa a quien la lea el año que viene;
    // es ruido con apariencia de orden.
    const user = userEvent.setup();
    await renderApp();

    await user.click(screen.getByRole('button', { name: /Notas y tareas/ }));

    const tabla = screen.getByRole('table', { name: 'Notas del proyecto' });
    await user.click(within(tabla).getAllByRole('row')[1] as HTMLElement);

    await user.click(screen.getByRole('button', { name: 'Resolver' }));
    const dialog = await screen.findByRole('dialog', { name: 'Resolver la nota' });

    // Sin resumen no se puede cerrar.
    expect(within(dialog).getByRole('button', { name: 'Resolver' })).toBeDisabled();

    await user.type(
      within(dialog).getByLabelText(/Cómo se resolvió/),
      'Apretada la brida y comprobada sin goteo tras 24 h.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Resolver' }));

    expect(await screen.findByText(/sin goteo tras 24 h/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deshacer' })).toBeEnabled();
  });

  // TEST-APP-023
  it('no adjunta a una nota un enlace javascript:', async () => {
    // El adjunto termina renderizado en el visor publicado, que es una página
    // servida a cualquiera con el enlace.
    const user = userEvent.setup();
    await renderApp();

    await user.click(screen.getByRole('button', { name: /Notas y tareas/ }));
    const tabla = screen.getByRole('table', { name: 'Notas del proyecto' });
    await user.click(within(tabla).getAllByRole('row')[1] as HTMLElement);

    await user.type(screen.getByLabelText(/^Enlace/), 'javascript:alert(1)');
    await user.click(screen.getByRole('button', { name: 'Adjuntar enlace' }));

    expect(await screen.findByText(/No se admiten enlaces/)).toBeInTheDocument();
    // Y no se ha escrito nada en el proyecto.
    expect(screen.getByRole('button', { name: 'Deshacer' })).toBeDisabled();
  });

  // TEST-APP-024
  it('publica un comentario en el hilo de una nota', async () => {
    const user = userEvent.setup();
    await renderApp();

    await user.click(screen.getByRole('button', { name: /Notas y tareas/ }));
    const tabla = screen.getByRole('table', { name: 'Notas del proyecto' });
    await user.click(within(tabla).getAllByRole('row')[1] as HTMLElement);

    const publicar = screen.getByRole('button', { name: 'Publicar comentario' });
    expect(publicar).toBeDisabled();

    await user.type(
      screen.getByLabelText(/Escribir un comentario/),
      'Avisado mantenimiento mecánico, entran el lunes.',
    );
    expect(publicar).toBeEnabled();
    await user.click(publicar);

    expect(await screen.findByText(/entran el lunes/)).toBeInTheDocument();
  });

  // TEST-APP-025
  it('no deja eliminar una categoría que alguna nota está usando', async () => {
    // Reasignar sus notas a «Otro» automáticamente sería cómodo y mentiroso:
    // una observación clasificada como fuga pasaría a no estar clasificada sin
    // que nadie lo decidiera.
    const user = userEvent.setup();
    await renderApp();

    await user.click(screen.getByRole('button', { name: /Notas y tareas/ }));
    await user.click(screen.getByRole('button', { name: 'Categorías' }));

    const dialog = await screen.findByRole('dialog', { name: 'Categorías de nota' });
    const tabla = within(dialog).getByRole('table', { name: 'Categorías del proyecto' });

    // Se busca una categoría con notas y otra sin ellas: la primera no se
    // puede borrar y la segunda sí.
    const filas = within(tabla).getAllByRole('row').slice(1);
    const conNotas = filas.find((fila) => {
      const celdas = fila.querySelectorAll('td');
      const cuenta = Number(celdas[celdas.length - 2]?.textContent ?? '0');
      return cuenta > 0;
    });
    const sinNotas = filas.find((fila) => {
      const celdas = fila.querySelectorAll('td');
      const cuenta = Number(celdas[celdas.length - 2]?.textContent ?? '0');
      const id = celdas[1]?.textContent ?? '';
      return cuenta === 0 && id !== 'other';
    });

    expect(conNotas).toBeDefined();
    expect(sinNotas).toBeDefined();
    if (conNotas === undefined || sinNotas === undefined) return;

    expect(within(conNotas).getByRole('button', { name: /^Eliminar / })).toBeDisabled();
    expect(within(sinNotas).getByRole('button', { name: /^Eliminar / })).toBeEnabled();
  });

  // TEST-APP-026
  it('renombrar el identificador de una categoría arrastra sus notas', async () => {
    // En dos pasos habría un instante con notas apuntando a una categoría que
    // no existe, y el filtro por categoría no las encontraría.
    const user = userEvent.setup();
    await renderApp();

    await user.click(screen.getByRole('button', { name: /Notas y tareas/ }));
    await user.click(screen.getByRole('button', { name: 'Categorías' }));

    const dialog = await screen.findByRole('dialog', { name: 'Categorías de nota' });
    const tabla = within(dialog).getByRole('table', { name: 'Categorías del proyecto' });

    const filas = within(tabla).getAllByRole('row').slice(1);
    const conNotas = filas.find((fila) => {
      const celdas = fila.querySelectorAll('td');
      return Number(celdas[celdas.length - 2]?.textContent ?? '0') > 0;
    });
    expect(conNotas).toBeDefined();
    if (conNotas === undefined) return;

    const celdas = conNotas.querySelectorAll('td');
    const idOriginal = celdas[1]?.textContent ?? '';
    const cuenta = Number(celdas[celdas.length - 2]?.textContent ?? '0');

    await user.click(conNotas);

    // El formulario avisa de cuántas notas se moverán.
    expect(
      within(dialog).getByText(new RegExp(`mueve también las ${cuenta} nota`)),
    ).toBeInTheDocument();

    const identificador = within(dialog).getByLabelText(/^Identificador/);
    await user.clear(identificador);
    await user.type(identificador, `${idOriginal}_v2`);
    await user.click(within(dialog).getByRole('button', { name: 'Guardar categoría' }));

    // La cuenta sigue en la categoría renombrada: las notas se movieron con ella.
    await waitFor(() => {
      const refrescada = within(
        within(dialog).getByRole('table', { name: 'Categorías del proyecto' }),
      ).getByText(`${idOriginal}_v2`);
      expect(refrescada).toBeInTheDocument();
    });

    const nuevaFila = within(dialog)
      .getAllByRole('row')
      .find((fila) => fila.textContent?.includes(`${idOriginal}_v2`));
    const nuevasCeldas = nuevaFila?.querySelectorAll('td');
    expect(Number(nuevasCeldas?.[(nuevasCeldas?.length ?? 1) - 2]?.textContent ?? '0')).toBe(cuenta);

    // Y no quedó ninguna nota huérfana apuntando al identificador viejo.
    expect(within(dialog).queryByText(/categorías sin definir/)).toBeNull();
  });

  // TEST-APP-027
  it('importar notas de campo enseña el informe y no duplica al repetir el archivo', async () => {
    // Estas observaciones se tomaron una sola vez, delante del equipo. El
    // informe tiene que distinguir lo que entra, lo que ya estaba y lo que se
    // rechaza, porque «importadas 9 de 12» no dice cuáles se perdieron.
    const user = userEvent.setup();
    await renderApp();

    const project = demoAssets.project;
    const scene = project.scenes[0];
    expect(scene).toBeDefined();
    if (scene === undefined) return;

    const bundle = bundleFieldNotes(
      [
        createFieldNote({
          sceneId: scene.id,
          yaw: 1.1,
          pitch: -0.2,
          title: 'Goteo en la brida de aspiración',
          body: 'Charco bajo la bomba.',
          categoryId: 'leak',
          priority: 'high',
          authorName: 'Operador de turno',
          now: '2026-06-01T08:00:00.000Z',
        }),
        createFieldNote({
          sceneId: newUuid(),
          yaw: 0,
          pitch: 0,
          title: 'Nota de una panorámica borrada',
          body: '',
          categoryId: 'leak',
          priority: 'normal',
          authorName: 'Operador de turno',
          now: '2026-06-01T08:05:00.000Z',
        }),
      ],
      project.id,
      project.title,
      '2026-06-02T10:00:00.000Z',
    );

    const file = new File([JSON.stringify(bundle)], 'notas-de-campo.json', {
      type: 'application/json',
    });

    await user.click(screen.getByRole('button', { name: /Notas y tareas/ }));
    await user.click(screen.getByRole('button', { name: 'Importar de campo' }));

    const dialog = await screen.findByRole('dialog', { name: 'Importar notas de campo' });
    await user.upload(within(dialog).getByLabelText('Archivo de notas de campo'), file);

    // Una entra; la de la panorámica inexistente se rechaza con su motivo, y
    // no cancela la buena.
    expect(await within(dialog).findByText(/1 nota\(s\) nueva\(s\)/)).toBeInTheDocument();
    const rechazadas = within(dialog).getByRole('table', { name: 'Notas rechazadas' });
    expect(within(rechazadas).getByText(/Nota de una panorámica borrada/)).toBeInTheDocument();
    expect(within(rechazadas).getByText(/ya no está en el proyecto/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Importar 1 nota(s)' }));
    expect(await within(dialog).findByText(/Importación aplicada/)).toBeInTheDocument();
    // El diálogo tiene la X de la cabecera y el botón del pie, ambos «Cerrar».
    const cerrar = within(dialog)
      .getAllByRole('button', { name: 'Cerrar' })
      .find((button) => button.textContent?.trim() === 'Cerrar');
    await user.click(cerrar as HTMLElement);

    // La nota aparece marcada como procedente del campo.
    const tabla = screen.getByRole('table', { name: 'Notas del proyecto' });
    const fila = within(tabla).getByText('Goteo en la brida de aspiración').closest('tr');
    expect(fila).not.toBeNull();
    expect(within(fila as HTMLElement).getByText('de campo')).toBeInTheDocument();

    // El mismo archivo otra vez no la duplica.
    await user.click(screen.getByRole('button', { name: 'Importar de campo' }));
    const segundo = await screen.findByRole('dialog', { name: 'Importar notas de campo' });
    await user.upload(
      within(segundo).getByLabelText('Archivo de notas de campo'),
      new File([JSON.stringify(bundle)], 'notas-de-campo.json', { type: 'application/json' }),
    );

    expect(await within(segundo).findByText(/ya se importaron antes/)).toBeInTheDocument();
    expect(within(segundo).getByRole('button', { name: 'Nada que importar' })).toBeDisabled();
  });

  // TEST-APP-028
  it('crea una interfaz desde una plantilla y la deja editable', async () => {
    // Una plantilla es un punto de partida, no un tema: lo que se crea es una
    // interfaz propia del proyecto que el autor puede cambiar entera.
    const user = userEvent.setup();
    await renderApp();

    await user.click(screen.getByRole('button', { name: /Interfaz del recorrido/ }));
    await user.click(screen.getByRole('button', { name: /Nueva interfaz|Crear interfaz/ }));

    const galeria = await screen.findByRole('dialog', { name: 'Nueva interfaz' });
    expect(within(galeria).getByText(/No queda ningún vínculo con la plantilla/)).toBeInTheDocument();

    await user.click(within(galeria).getByRole('button', { name: /Usar «Recorrido industrial»/ }));

    // Los componentes de la plantilla están en el árbol y en el lienzo.
    const arbol = await screen.findByRole('tree', { name: 'Árbol de componentes' });
    const nombres = within(arbol)
      .getAllByRole('treeitem')
      .map((item) => item.textContent ?? '');
    expect(nombres.some((name) => name.includes('Cabecera'))).toBe(true);
    expect(nombres.some((name) => name.includes('Proceso'))).toBe(true);
    // La cabecera trae el logotipo y el título dentro, anidados un nivel.
    expect(within(arbol).getAllByRole('treeitem').length).toBeGreaterThanOrEqual(6);
    expect(screen.getByRole('button', { name: 'Deshacer' })).toBeEnabled();
  });

  // TEST-APP-029
  it('el editor de interfaz añade un componente y permite renombrarlo', async () => {
    const user = userEvent.setup();
    await renderApp();

    await user.click(screen.getByRole('button', { name: /Interfaz del recorrido/ }));
    await user.click(screen.getByRole('button', { name: /Nueva interfaz|Crear interfaz/ }));
    const galeria = await screen.findByRole('dialog', { name: 'Nueva interfaz' });
    await user.click(within(galeria).getByRole('button', { name: 'Empezar de cero' }));

    expect(await screen.findByText(/La interfaz está vacía/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Botón' }));

    const arbol = await screen.findByRole('tree', { name: 'Árbol de componentes' });
    expect(within(arbol).getAllByRole('treeitem')).toHaveLength(1);

    // Queda seleccionado, así que sus propiedades están a la vista.
    const nombre = screen.getByLabelText('Nombre');
    await user.clear(nombre);
    await user.type(nombre, 'Cerrar panel');

    await waitFor(() => {
      expect(within(arbol).getByText('Cerrar panel')).toBeInTheDocument();
    });
  });

  // TEST-APP-030
  it('no deja meter un componente dentro de algo que no es contenedor', async () => {
    // El nodo existiría en el archivo, se vería en el árbol y no aparecería
    // nunca en el recorrido: la peor clase de fallo, el que no da señal.
    const user = userEvent.setup();
    await renderApp();

    await user.click(screen.getByRole('button', { name: /Interfaz del recorrido/ }));
    await user.click(screen.getByRole('button', { name: /Nueva interfaz|Crear interfaz/ }));
    const galeria = await screen.findByRole('dialog', { name: 'Nueva interfaz' });
    await user.click(within(galeria).getByRole('button', { name: 'Empezar de cero' }));

    // Una imagen no es contenedor; al tenerla seleccionada, el componente
    // siguiente va a la raíz en lugar de dentro de ella.
    await user.click(screen.getByRole('button', { name: 'Imagen' }));
    await user.click(screen.getByRole('button', { name: 'Texto' }));

    const arbol = await screen.findByRole('tree', { name: 'Árbol de componentes' });
    const items = within(arbol).getAllByRole('treeitem');
    expect(items).toHaveLength(2);
    // Ambos al mismo nivel: ninguno quedó dentro del otro.
    for (const item of items) {
      expect(item).toHaveAttribute('aria-level', '1');
    }
  });

  // TEST-APP-031
  it('eliminar un contenedor dice cuántos componentes se lleva por delante', async () => {
    const user = userEvent.setup();
    await renderApp();

    await user.click(screen.getByRole('button', { name: /Interfaz del recorrido/ }));
    await user.click(screen.getByRole('button', { name: /Nueva interfaz|Crear interfaz/ }));
    const galeria = await screen.findByRole('dialog', { name: 'Nueva interfaz' });
    await user.click(within(galeria).getByRole('button', { name: /Usar «Recorrido industrial»/ }));

    const arbol = await screen.findByRole('tree', { name: 'Árbol de componentes' });
    await user.click(within(arbol).getByText('Cabecera'));
    await user.click(screen.getByRole('button', { name: 'Eliminar' }));

    const confirmacion = await screen.findByRole('dialog', { name: 'Eliminar componente' });
    // La cabecera lleva el logotipo y el título dentro: tres en total.
    expect(within(confirmacion).getByText(/Se eliminarán 3 componentes/)).toBeInTheDocument();
    expect(within(confirmacion).getByText(/deshacer con Ctrl\+Z/)).toBeInTheDocument();
  });

  // TEST-APP-032
  it('crea una escena de modelo 3D con los tres modos de cámara disponibles', async () => {
    // Nace con los valores con los que un modelo de planta es navegable en un
    // portátil corriente, que es donde se va a abrir.
    const user = userEvent.setup();
    await renderApp();

    await user.click(screen.getByRole('button', { name: 'Más acciones' }));
    await user.click(await screen.findByRole('menuitem', { name: /Añadir escena de modelo 3D/ }));

    expect(await screen.findByText(/Sin modelo cargado/)).toBeInTheDocument();

    // Los tres modos están permitidos de salida.
    for (const modo of ['Orbital', 'Sobrevuelo', 'Primera persona']) {
      expect(screen.getByLabelText(modo)).toBeChecked();
    }
    expect(screen.getByLabelText('Resolución adaptativa')).toBeChecked();
  });

  // TEST-APP-033
  it('rechaza un archivo que no es un modelo y dice qué exportar', async () => {
    // Sin esta comprobación el cargador lanza desde dentro de una promesa y el
    // lienzo se queda en negro sin decir por qué.
    const user = userEvent.setup();
    await renderApp();

    await user.click(screen.getByRole('button', { name: 'Más acciones' }));
    await user.click(await screen.findByRole('menuitem', { name: /Añadir escena de modelo 3D/ }));

    const campo = await screen.findByLabelText('Archivo del modelo 3D');

    // El caso real: un archivo con extensión .glb que no lo es, porque se
    // renombró o porque la exportación del CAD falló a medias.
    const falso = new File([new TextEncoder().encode('%PDF-1.7\nno soy un modelo')], 'planta.glb', {
      type: 'model/gltf-binary',
    });
    await user.upload(campo, falso);

    const aviso = await screen.findByText(/no es un modelo glTF ni GLB/);
    expect(aviso.textContent).toContain('.glb');
  });

  // TEST-APP-034
  it('la comprobación previa avisa de lo que no funcionará con gafas puestas', async () => {
    // Con las gafas puestas, un marcador de un tipo que VR no admite
    // simplemente no está, y lo que falta puede ser justo el que lleva a la
    // escena siguiente. Es un aviso y no un bloqueo, pero tiene que verse
    // antes de publicar.
    const user = userEvent.setup();
    await renderApp();

    await user.click(screen.getByRole('button', { name: /Publicación/ }));

    const etiqueta = await screen.findByText('Compatibilidad con visores VR');
    const bloque = etiqueta.closest('.integrity__item');
    expect(bloque).not.toBeNull();

    // El proyecto de demostración es compatible: la comprobación pasa y nombra
    // el perfil con el que se juzgó.
    expect(within(bloque as HTMLElement).getByText(/Visor autónomo/)).toBeInTheDocument();
  });

  // TEST-APP-010
  it('eliminar una escena pide confirmación y advierte del arrastre de referencias', async () => {
    const user = userEvent.setup();
    await renderApp();

    await user.click(screen.getByRole('button', { name: 'Eliminar escena' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/ubicaciones de activos que la referencian/)).toBeInTheDocument();
    // El foco cae en Cancelar, no en el botón destructivo.
    expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toHaveFocus();
  });
});

/** Pulsa un módulo del raíl por su nombre accesible. */
async function user_click(moduleLabel: string): Promise<void> {
  const user = userEvent.setup();
  const matcher = new RegExp(moduleLabel);
  await user.click(screen.getByRole('button', { name: matcher }));
}
