"""El hilo de snapshots sobrevive a un fallo al decidir qué portfolios guardar."""

from admin import snapshot_scheduler


def testUnFalloAlElegirPortfoliosNoMataElBucle(monkeypatch):
    def falla():
        raise OSError("disco")

    monkeypatch.setattr(snapshot_scheduler, "_rutasObjetivo", falla)

    assert snapshot_scheduler.ejecutarUnaVez() == 0
