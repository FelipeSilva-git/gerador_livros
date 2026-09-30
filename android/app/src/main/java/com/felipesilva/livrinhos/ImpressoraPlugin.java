package com.felipesilva.livrinhos;

import android.content.Context;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Imprime a página atual do app pelo sistema de impressão do Android
 * (impressora Wi-Fi ou "Salvar como PDF"), sem margens, no tamanho de folha
 * pedido pela tela (larguraMm x alturaMm, como a folha sai da impressora).
 * A tela monta as folhas na área de impressão antes de chamar.
 */
@CapacitorPlugin(name = "Impressora")
public class ImpressoraPlugin extends Plugin {

    @PluginMethod
    public void imprimir(PluginCall call) {
        String nome = call.getString("nome", "Livrinho");
        double largura = call.getDouble("larguraMm", 297.0);
        double altura = call.getDouble("alturaMm", 210.0);
        getActivity().runOnUiThread(() -> {
            try {
                PrintManager impressao = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
                PrintDocumentAdapter adaptador = getBridge().getWebView().createPrintDocumentAdapter(nome);
                PrintAttributes atributos = new PrintAttributes.Builder()
                    .setMediaSize(tamanhoDoPapel(largura, altura))
                    .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                    .build();
                impressao.print(nome, adaptador, atributos);
                call.resolve();
            } catch (Exception e) {
                call.reject("Erro ao abrir a impressão: " + e.getMessage());
            }
        });
    }

    /** Usa o papel conhecido pela impressora quando bate com a medida; senão, um tamanho personalizado. */
    private static PrintAttributes.MediaSize tamanhoDoPapel(double larguraMm, double alturaMm) {
        double curto = Math.min(larguraMm, alturaMm);
        double longo = Math.max(larguraMm, alturaMm);
        PrintAttributes.MediaSize papel;
        if (parecido(curto, longo, 210, 297)) papel = PrintAttributes.MediaSize.ISO_A4;
        else if (parecido(curto, longo, 297, 420)) papel = PrintAttributes.MediaSize.ISO_A3;
        else if (parecido(curto, longo, 148, 210)) papel = PrintAttributes.MediaSize.ISO_A5;
        else if (parecido(curto, longo, 215.9, 279.4)) papel = PrintAttributes.MediaSize.NA_LETTER;
        else if (parecido(curto, longo, 215.9, 355.6)) papel = PrintAttributes.MediaSize.NA_LEGAL;
        else {
            int milesimosCurto = (int) Math.round(curto / 25.4 * 1000);
            int milesimosLongo = (int) Math.round(longo / 25.4 * 1000);
            String id = "livrinhos_" + Math.round(curto) + "x" + Math.round(longo);
            papel = new PrintAttributes.MediaSize(id, Math.round(curto) + " x " + Math.round(longo) + " mm",
                milesimosCurto, milesimosLongo);
        }
        return larguraMm > alturaMm ? papel.asLandscape() : papel.asPortrait();
    }

    private static boolean parecido(double curto, double longo, double c, double l) {
        return Math.abs(curto - c) < 2 && Math.abs(longo - l) < 2;
    }
}
