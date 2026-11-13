/**
 * Pruebas de la conexión automática.
 *
 * El objeto de estas pruebas no es que el algoritmo acierte —no puede
 * garantizarlo y el plan no lo exige— sino que **no mienta**: que la confianza
 * corresponda a la señal que usó, que una señal débil se declare débil, que
 * nunca devuelva certeza, y que no invente distancias cuando no las puede
 * calcular. Un algoritmo experimental que se presenta con la humildad correcta
 * es útil; el mismo algoritmo presentado con seguridad es una trampa.
 */
import { describe, expect, it } from 'vitest';
import { degToRad, radToDeg, type Media, type Scene } from '@it360/domain';
import { makeMedia, makePlan, makePlanMarker, makeScene, testUuid } from '@it360/domain/testing';
import { EVIDENCE_LABELS, proposeConnections, summarizeProposals } from './autoconnect';

const PROJECT = testUuid(1);

/** Panorámica con GPS y rumbo de captura opcional. */
function mediaWithGps(
  n: number,
  latitude: number,
  longitude: number,
  headingDeg: number | null = null,
  createdAt = '2026-03-01T10:00:00.000Z',
): Media {
  const base = makeMedia(n, { createdAt });
  return {
    ...base,
    panorama: {
      coverage: { horizontalDeg: 360, verticalDeg: 180, centerYaw: 0, centerPitch: 0 },
      equirectangular: true,
      capturedHeadingRad: headingDeg === null ? null : degToRad(headingDeg),
      captureHeightM: 1.6,
      gps: { latitude, longitude, altitudeM: null },
    },
  };
}

function sceneWith(n: number, media: Media): Scene {
  return makeScene(n, PROJECT, { mediaId: media.id, title: `Escena ${n}` });
}

describe('proposeConnections — GPS', () => {
  /**
   * Dos capturas separadas unos 11 m en latitud. A la latitud de Cartagena,
   * 0,0001° ≈ 11 m, suficiente para que la distancia sea comprobable sin
   * depender de la precisión de la fórmula.
   */
  const south = mediaWithGps(1, 10.4, -75.5, 0);
  const north = mediaWithGps(2, 10.4001, -75.5, 0);

  // TEST-ACN-001
  it('propone la conexión entre las capturas cercanas', () => {
    const result = proposeConnections({
      scenes: [sceneWith(11, south), sceneWith(12, north)],
      media: [south, north],
    });

    expect(result.evidence).toBe('gps');
    expect(result.proposals).toHaveLength(2); // Ida y vuelta.
    expect(result.proposals[0]?.distanceM ?? 0).toBeGreaterThan(5);
    expect(result.proposals[0]?.distanceM ?? 0).toBeLessThan(20);
  });

  // TEST-ACN-002
  it('orienta el marcador al norte cuando el destino está al norte', () => {
    const result = proposeConnections({
      scenes: [sceneWith(11, south), sceneWith(12, north)],
      media: [south, north],
    });

    const forward = result.proposals.find((p) => p.fromSceneId === testUuid(11));
    expect(forward).toBeDefined();
    // Capturada mirando al norte (rumbo 0), el destino al norte: azimut 0.
    expect(radToDeg(forward?.yaw ?? 99)).toBeCloseTo(0, 1);
  });

  // TEST-ACN-003
  it('corrige el azimut por el rumbo de la captura', () => {
    // La misma geometría, pero la panorámica se capturó mirando al este: el
    // norte queda a 90° a la izquierda del centro de la imagen.
    const facingEast = mediaWithGps(1, 10.4, -75.5, 90);
    const result = proposeConnections({
      scenes: [sceneWith(11, facingEast), sceneWith(12, north)],
      media: [facingEast, north],
    });

    const forward = result.proposals.find((p) => p.fromSceneId === testUuid(11));
    expect(radToDeg(forward?.yaw ?? 0)).toBeCloseTo(-90, 1);
  });

  // TEST-ACN-004
  it('baja la confianza y lo dice cuando la captura no registró su rumbo', () => {
    const noHeading = mediaWithGps(1, 10.4, -75.5, null);
    const withHeading = mediaWithGps(3, 10.4, -75.5, 0);

    const sinRumbo = proposeConnections({
      scenes: [sceneWith(11, noHeading), sceneWith(12, north)],
      media: [noHeading, north],
    });
    const conRumbo = proposeConnections({
      scenes: [sceneWith(11, withHeading), sceneWith(12, north)],
      media: [withHeading, north],
    });

    const a = sinRumbo.proposals.find((p) => p.fromSceneId === testUuid(11));
    const b = conRumbo.proposals.find((p) => p.fromSceneId === testUuid(11));

    expect(a?.confidence ?? 1).toBeLessThan(b?.confidence ?? 0);
    expect(a?.reason).toContain('no registró su rumbo');
  });

  // TEST-ACN-005
  it('no propone nada cuando el GPS dice que están lejos, y no cae a una señal peor', () => {
    // Proponer por orden de captura aquí sería contradecir el dato bueno con
    // el malo: las coordenadas ya dicen que no son contiguas.
    const faraway = mediaWithGps(2, 10.5, -75.5, 0); // ~11 km
    const result = proposeConnections({
      scenes: [sceneWith(11, south), sceneWith(12, faraway)],
      media: [south, faraway],
      options: { maxDistanceM: 40 },
    });

    expect(result.proposals).toHaveLength(0);
    expect(result.evidence).toBe('gps');
    expect(result.emptyReason).toBe('tooFar');
    expect(summarizeProposals(result)).toContain('no son contiguas');
  });

  // TEST-ACN-006
  it('la confianza decae con la distancia', () => {
    const near = mediaWithGps(2, 10.40002, -75.5, 0); // ~2 m
    const far = mediaWithGps(3, 10.4003, -75.5, 0); // ~33 m

    const cerca = proposeConnections({
      scenes: [sceneWith(11, south), sceneWith(12, near)],
      media: [south, near],
    });
    const lejos = proposeConnections({
      scenes: [sceneWith(11, south), sceneWith(13, far)],
      media: [south, far],
    });

    expect(cerca.proposals[0]?.confidence ?? 0).toBeGreaterThan(
      lejos.proposals[0]?.confidence ?? 1,
    );
  });

  // TEST-ACN-007
  it('nunca devuelve certeza', () => {
    const result = proposeConnections({
      scenes: [sceneWith(11, south), sceneWith(12, north)],
      media: [south, north],
    });

    // Ninguna de estas señales demuestra que dos escenas sean contiguas: entre
    // dos capturas a dos metros puede haber una pared.
    for (const proposal of result.proposals) {
      expect(proposal.confidence).toBeLessThan(1);
      expect(proposal.confidence).toBeGreaterThan(0);
    }
  });

  // TEST-ACN-008
  it('limita el número de propuestas por escena', () => {
    const others = [2, 3, 4, 5, 6].map((n) => mediaWithGps(n, 10.4 + n * 0.00002, -75.5, 0));
    const result = proposeConnections({
      scenes: [sceneWith(11, south), ...others.map((m, i) => sceneWith(20 + i, m))],
      media: [south, ...others],
      options: { maxPerScene: 2 },
    });

    const fromFirst = result.proposals.filter((p) => p.fromSceneId === testUuid(11));
    expect(fromFirst.length).toBeLessThanOrEqual(2);
  });
});

describe('proposeConnections — plano', () => {
  const plan = makePlan(1, testUuid(50));
  const mediaA = makeMedia(1);
  const mediaB = makeMedia(2);
  const sceneA = sceneWith(11, mediaA);
  const sceneB = sceneWith(12, mediaB);

  // TEST-ACN-009
  it('usa el plano cuando no hay GPS', () => {
    const result = proposeConnections({
      scenes: [sceneA, sceneB],
      media: [mediaA, mediaB],
      plans: [plan],
      planMarkers: [
        makePlanMarker(1, plan.id, sceneA.id, { position: { x: 0.3, y: 0.5 } }),
        makePlanMarker(2, plan.id, sceneB.id, { position: { x: 0.6, y: 0.5 } }),
      ],
    });

    expect(result.evidence).toBe('plan');
    expect(result.proposals.length).toBeGreaterThan(0);
  });

  // TEST-ACN-010
  it('no inventa una distancia en metros que el plano no permite calcular', () => {
    const result = proposeConnections({
      scenes: [sceneA, sceneB],
      media: [mediaA, mediaB],
      plans: [plan],
      planMarkers: [
        makePlanMarker(1, plan.id, sceneA.id, { position: { x: 0.3, y: 0.5 } }),
        makePlanMarker(2, plan.id, sceneB.id, { position: { x: 0.6, y: 0.5 } }),
      ],
    });

    expect(result.proposals[0]?.distanceM).toBeNull();
    expect(result.proposals[0]?.reason).toContain('no declara escala');
  });

  // TEST-ACN-011
  it('orienta el marcador según el eje del plano, con la Y invertida', () => {
    // El destino está «arriba» en la imagen, que con el eje Y hacia abajo
    // significa al norte del plano. Sin invertir, el marcador apuntaría al sur
    // y el error pasaría inadvertido en un plano simétrico.
    const result = proposeConnections({
      scenes: [sceneA, sceneB],
      media: [mediaA, mediaB],
      plans: [{ ...plan, orientation: { northRad: 0, sceneNorthOffsetRad: 0 } }],
      planMarkers: [
        makePlanMarker(1, plan.id, sceneA.id, { position: { x: 0.5, y: 0.6 } }),
        makePlanMarker(2, plan.id, sceneB.id, { position: { x: 0.5, y: 0.3 } }),
      ],
    });

    const forward = result.proposals.find((p) => p.fromSceneId === sceneA.id);
    expect(radToDeg(forward?.yaw ?? 99)).toBeCloseTo(0, 1);
  });

  // TEST-ACN-012
  it('la confianza del plano no alcanza la del GPS', () => {
    const porPlano = proposeConnections({
      scenes: [sceneA, sceneB],
      media: [mediaA, mediaB],
      plans: [plan],
      planMarkers: [
        makePlanMarker(1, plan.id, sceneA.id, { position: { x: 0.5, y: 0.5 } }),
        makePlanMarker(2, plan.id, sceneB.id, { position: { x: 0.52, y: 0.5 } }),
      ],
    });

    const gpsA = mediaWithGps(1, 10.4, -75.5, 0);
    const gpsB = mediaWithGps(2, 10.40002, -75.5, 0);
    const porGps = proposeConnections({
      scenes: [sceneWith(11, gpsA), sceneWith(12, gpsB)],
      media: [gpsA, gpsB],
    });

    expect(porPlano.proposals[0]?.confidence ?? 1).toBeLessThan(
      porGps.proposals[0]?.confidence ?? 0,
    );
  });
});

describe('proposeConnections — orden de captura', () => {
  const first = makeMedia(1, { createdAt: '2026-03-01T10:00:00.000Z' });
  const second = makeMedia(2, { createdAt: '2026-03-01T10:05:00.000Z' });
  const third = makeMedia(3, { createdAt: '2026-03-01T10:10:00.000Z' });

  // TEST-ACN-013
  it('encadena las escenas en orden temporal como último recurso', () => {
    const result = proposeConnections({
      scenes: [sceneWith(13, third), sceneWith(11, first), sceneWith(12, second)],
      media: [first, second, third],
    });

    expect(result.evidence).toBe('captureOrder');
    expect(result.proposals.map((p) => p.fromSceneId)).toEqual([testUuid(11), testUuid(12)]);
  });

  // TEST-ACN-014
  it('declara que la dirección es una convención y hay que colocarla a mano', () => {
    const result = proposeConnections({
      scenes: [sceneWith(11, first), sceneWith(12, second)],
      media: [first, second],
    });

    expect(result.proposals[0]?.confidence ?? 1).toBeLessThanOrEqual(0.35);
    expect(result.proposals[0]?.reason).toContain('convención');
    expect(result.proposals[0]?.distanceM).toBeNull();
  });

  // TEST-ACN-015
  it('la confianza mínima puede descartar la señal débil por completo', () => {
    const result = proposeConnections({
      scenes: [sceneWith(11, first), sceneWith(12, second)],
      media: [first, second],
      options: { minConfidence: 0.5 },
    });

    expect(result.proposals).toHaveLength(0);
  });
});

describe('proposeConnections — casos sin salida', () => {
  // TEST-ACN-016
  it('señala las escenas sin imagen en lugar de ignorarlas', () => {
    const media = makeMedia(1);
    const sinImagen = makeScene(99, PROJECT, { mediaId: null });

    const result = proposeConnections({
      scenes: [sceneWith(11, media), sinImagen],
      media: [media],
    });

    expect(result.skipped.some((s) => s.sceneId === sinImagen.id)).toBe(true);
    expect(result.skipped[0]?.reason).toContain('no tiene imagen');
  });

  // TEST-ACN-017
  it('con una sola escena no propone nada y lo explica', () => {
    const media = makeMedia(1);
    const result = proposeConnections({ scenes: [sceneWith(11, media)], media: [media] });

    expect(result.proposals).toHaveLength(0);
    expect(result.evidence).toBeNull();
    expect(summarizeProposals(result)).toContain('No hay información suficiente');
  });
});

describe('summarizeProposals', () => {
  // TEST-ACN-018
  it('advierte de que las propuestas entran sin revisar', () => {
    // Es la frase que impide que el autor crea que el trabajo está hecho.
    const a = mediaWithGps(1, 10.4, -75.5, 0);
    const b = mediaWithGps(2, 10.4001, -75.5, 0);
    const result = proposeConnections({
      scenes: [sceneWith(11, a), sceneWith(12, b)],
      media: [a, b],
    });

    const summary = summarizeProposals(result);
    expect(summary).toContain('sin revisar');
    expect(summary).toContain('no se publicarán');
    expect(summary).toContain(EVIDENCE_LABELS.gps);
  });

  // TEST-ACN-019
  it('informa del rango de confianza para poder ordenar la revisión', () => {
    const a = mediaWithGps(1, 10.4, -75.5, 0);
    const b = mediaWithGps(2, 10.40002, -75.5, 0);
    const c = mediaWithGps(3, 10.4003, -75.5, null);
    const result = proposeConnections({
      scenes: [sceneWith(11, a), sceneWith(12, b), sceneWith(13, c)],
      media: [a, b, c],
    });

    expect(summarizeProposals(result)).toMatch(/Confianza entre \d+ % y \d+ %/);
  });
});
