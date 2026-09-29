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
 * (impressora Wi-Fi ou "Salvar como PDF"), em A4 sem margens: deitado (livro)
 * ou em pé (uma página avulsa, com "retrato": true).
 * A tela monta as folhas na área de impressão antes de chamar.
 */
@CapacitorPlugin(name = "Impressora")
public class ImpressoraPlugin extends Plugin {

    @PluginMethod
    public void imprimir(PluginCall call) {
        String nome = call.getString("nome", "Livrinho");
        boolean retrato = Boolean.TRUE.equals(call.getBoolean("retrato", false));
        getActivity().runOnUiThread(() -> {
            try {
                PrintManager impressao = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
                PrintDocumentAdapter adaptador = getBridge().getWebView().createPrintDocumentAdapter(nome);
                PrintAttributes atributos = new PrintAttributes.Builder()
                    .setMediaSize(retrato
                        ? PrintAttributes.MediaSize.ISO_A4.asPortrait()
                        : PrintAttributes.MediaSize.ISO_A4.asLandscape())
                    .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                    .build();
                impressao.print(nome, adaptador, atributos);
                call.resolve();
            } catch (Exception e) {
                call.reject("Erro ao abrir a impressão: " + e.getMessage());
            }
        });
    }
}
