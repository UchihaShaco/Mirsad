# Keep stack traces readable in the hackathon build; shrink only.
-dontobfuscate
-keepattributes SourceFile,LineNumberTable,*Annotation*,Signature,InnerClasses,EnclosingMethod
# kotlinx.serialization
-keepclassmembers class kotlinx.serialization.json.** { *** Companion; }
-keepclasseswithmembers class kotlinx.serialization.json.** { kotlinx.serialization.KSerializer serializer(...); }
-keep,includedescriptorclasses class app.mirsad.**$$serializer { *; }
-keepclassmembers class app.mirsad.** { *** Companion; }
-keepclasseswithmembers class app.mirsad.** { kotlinx.serialization.KSerializer serializer(...); }
# Components referenced from the manifest
-keep class app.mirsad.shield.service.** { *; }
-keep class app.mirsad.shield.share.** { *; }
-keep class app.mirsad.shield.demo.** { *; }
-keep class app.mirsad.shield.MirsadApp { *; }
# Trainer entry point lives in core main; keep it discoverable
-keep class app.mirsad.core.ml.train.** { *; }
